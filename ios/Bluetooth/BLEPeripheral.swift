import Foundation
import CoreBluetooth
import PhoneBridgeCore

/// GATT peripheral: one RX (write) and one TX (notify) characteristic carrying a byte stream.
/// All callbacks arrive on the main queue.
final class BLEPeripheral: NSObject, CBPeripheralManagerDelegate {
    static let serviceUUID = CBUUID(string: PBWire.serviceUUID)
    static let rxUUID = CBUUID(string: PBWire.rxUUID)
    static let txUUID = CBUUID(string: PBWire.txUUID)

    var onStateText: ((String) -> Void)?
    var onConnect: ((CBCentral) -> Void)?
    var onDisconnect: (() -> Void)?
    var onReceive: ((Data) -> Void)?
    var onDrain: (() -> Void)?

    private var manager: CBPeripheralManager!
    private var rx: CBMutableCharacteristic?
    private var tx: CBMutableCharacteristic?
    private(set) var central: CBCentral?
    private var serviceAdded = false

    private var queue = Data()
    private var head = 0
    var pendingBytes: Int { queue.count - head }
    private(set) var bytesSent: Int = 0
    private(set) var bytesReceived: Int = 0

    override init() {
        super.init()
        manager = CBPeripheralManager(delegate: self, queue: nil,
                                      options: [CBPeripheralManagerOptionShowPowerAlertKey: true])
    }

    var isConnected: Bool { central != nil }
    var packetSize: Int { central.map { max(20, $0.maximumUpdateValueLength) } ?? 0 }

    // MARK: - Sending

    func send(_ data: Data) {
        guard central != nil else { return }
        queue.append(data)
        pump()
    }

    func clearQueue() {
        queue = Data()
        head = 0
    }

    private func pump() {
        guard let central, let tx else { return }
        let size = max(20, central.maximumUpdateValueLength)
        while head < queue.count {
            let n = min(size, queue.count - head)
            let start = queue.startIndex + head
            let chunk = queue.subdata(in: start..<(start + n))
            guard manager.updateValue(chunk, for: tx, onSubscribedCentrals: [central]) else { return }
            head += n
            bytesSent += n
            if head >= 64 * 1024 && head * 2 >= queue.count {
                queue = queue.subdata(in: (queue.startIndex + head)..<queue.endIndex)
                head = 0
            }
        }
        clearQueue()
        onDrain?()
    }

    // MARK: - CBPeripheralManagerDelegate

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        switch peripheral.state {
        case .poweredOn:
            onStateText?("Bluetooth on")
            addService()
        case .poweredOff:
            onStateText?("Bluetooth is off")
            dropCentral()
            serviceAdded = false
        case .unauthorized:
            onStateText?("Bluetooth permission denied — enable it in Settings › PhoneBridge")
        case .unsupported:
            onStateText?("Bluetooth LE peripheral mode unsupported")
        case .resetting:
            onStateText?("Bluetooth resetting…")
            dropCentral()
            serviceAdded = false
        default:
            onStateText?("Bluetooth state unknown")
        }
    }

    private func addService() {
        guard !serviceAdded else { return startAdvertising() }
        let rx = CBMutableCharacteristic(type: Self.rxUUID, properties: [.write, .writeWithoutResponse],
                                         value: nil, permissions: [.writeable])
        let tx = CBMutableCharacteristic(type: Self.txUUID, properties: [.notify],
                                         value: nil, permissions: [.readable])
        let service = CBMutableService(type: Self.serviceUUID, primary: true)
        service.characteristics = [rx, tx]
        self.rx = rx
        self.tx = tx
        manager.removeAllServices()
        manager.add(service)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error {
            onStateText?("Could not add BLE service: \(error.localizedDescription)")
            return
        }
        serviceAdded = true
        startAdvertising()
    }

    func startAdvertising() {
        guard manager.state == .poweredOn, serviceAdded, !manager.isAdvertising else { return }
        manager.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [Self.serviceUUID],
            CBAdvertisementDataLocalNameKey: "PhoneBridge",
        ])
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error {
            onStateText?("Advertising failed: \(error.localizedDescription)")
        } else if central == nil {
            onStateText?("Waiting for Chromebook")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                           didSubscribeTo characteristic: CBCharacteristic) {
        guard characteristic.uuid == Self.txUUID else { return }
        if let old = self.central, old.identifier != central.identifier {
            // A new client replaces a stale one (iOS has no API to force-disconnect a central).
            onDisconnect?()
        }
        self.central = central
        clearQueue()
        bytesSent = 0
        bytesReceived = 0
        onConnect?(central)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                           didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard characteristic.uuid == Self.txUUID, central.identifier == self.central?.identifier else { return }
        dropCentral()
        startAdvertising()
    }

    private func dropCentral() {
        guard central != nil else { return }
        central = nil
        clearQueue()
        onDisconnect?()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }
        // Requests for one long write arrive together, ordered by offset.
        for request in requests where request.characteristic.uuid == Self.rxUUID {
            guard request.central.identifier == central?.identifier, let value = request.value else { continue }
            bytesReceived += value.count
            onReceive?(value)
        }
        peripheral.respond(to: first, withResult: .success)
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        pump()
    }
}
