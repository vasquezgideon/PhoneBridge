import SwiftUI
import PhoneBridgeCore

struct DashboardView: View {
    @EnvironmentObject var model: AppModel
    @State private var showPasswordSheet = false
    @State private var confirmRemovePassword = false
    @State private var confirmReset = false
    @State private var showLog = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Kept outside the List so the web view never leaves the window.
                WebPreview(webView: model.browser.webView)
                    .aspectRatio(BrowserController.viewport.width / BrowserController.viewport.height, contentMode: .fit)
                    .overlay(alignment: .top) { ProgressBar(browser: model.browser) }
                AddressBar(browser: model.browser)
                List {
                    connectionSection
                    devicesSection
                    securitySection
                    displaySection
                    browserSection
                    phoneSection
                    Section {
                        Button("Factory reset…", role: .destructive) { confirmReset = true }
                    } footer: {
                        Text("Removes trusted Chromebooks, the password, settings and all website data on this iPhone.")
                    }
                }
                .listStyle(.insetGrouped)
            }
            .navigationTitle("PhoneBridge")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $model.pairingPrompt) { prompt in
                PairingApprovalView(prompt: prompt) { model.answerPairing($0) }
                    .interactiveDismissDisabled()
            }
            .sheet(isPresented: $showPasswordSheet) {
                PasswordSheet(isChange: model.passwordSet) { model.setPasswordLocally($0) }
            }
            .confirmationDialog("Remove the unlock password?", isPresented: $confirmRemovePassword, titleVisibility: .visible) {
                Button("Remove password", role: .destructive) { model.removePasswordLocally() }
            }
            .confirmationDialog("Reset PhoneBridge?", isPresented: $confirmReset, titleVisibility: .visible) {
                Button("Erase everything", role: .destructive) { model.factoryReset() }
            } message: {
                Text("Trusted devices, password, settings, cookies and site data will be deleted.")
            }
        }
    }

    private var connectionSection: some View {
        Section("Connection") {
            LabeledContent("Bluetooth", value: model.bluetoothText)
            LabeledContent("Status", value: model.link.label)
            if !model.stats.isEmpty {
                Text(model.stats).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            if let until = model.pairingOpenUntil {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let left = max(0, Int(until.timeIntervalSince(ctx.date)))
                    HStack {
                        Label("Pairing open — \(left / 60):\(String(format: "%02ld", left % 60))",
                              systemImage: "antenna.radiowaves.left.and.right")
                        Spacer()
                        Button("Close") { model.closePairing() }
                    }
                }
            } else {
                Button { model.openPairing() } label: { Label("Pair new Chromebook", systemImage: "plus.circle") }
            }
        }
    }

    private var devicesSection: some View {
        Section {
            if model.devices.isEmpty {
                Text("No trusted Chromebooks yet.").foregroundStyle(.secondary)
            }
            ForEach(model.devices) { d in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(d.name).font(.body.weight(.medium))
                        if d.id == model.currentDeviceId {
                            Text("connected").font(.caption2).padding(.horizontal, 6).padding(.vertical, 2)
                                .background(.green.opacity(0.2), in: Capsule())
                        }
                    }
                    Text("Paired \(d.pairedAt.formatted(date: .abbreviated, time: .shortened)) · last seen \(d.lastSeen.formatted(.relative(presentation: .named)))"
                         + (d.passwordRemembered ? " · remembered" : ""))
                        .font(.caption).foregroundStyle(.secondary)
                }
                .swipeActions {
                    Button("Revoke", role: .destructive) { model.revoke(id: d.id) }
                }
            }
        } header: {
            Text("Trusted Chromebooks")
        } footer: {
            if !model.devices.isEmpty { Text("Swipe left to revoke.") }
        }
    }

    private var securitySection: some View {
        Section {
            if model.passwordSet {
                Button("Change unlock password…") { showPasswordSheet = true }
                Button("Remove password", role: .destructive) { confirmRemovePassword = true }
                Toggle("Require on every reconnect", isOn: $model.settings.requirePasswordEveryReconnect)
            } else {
                Button("Set unlock password…") { showPasswordSheet = true }
            }
        } header: {
            Text("Security")
        } footer: {
            Text(model.passwordSet
                 ? "Trusted Chromebooks must enter this password to unlock, unless they chose “Remember this device”."
                 : "Optional. Without a password, a trusted Chromebook unlocks as soon as it reconnects.")
        }
    }

    private var displaySection: some View {
        Section("Display stream") {
            SliderRow(title: "JPEG quality", value: $model.settings.display.quality, range: 0.1...0.95, format: { "\(Int($0 * 100))%" })
            SliderRow(title: "Resolution", value: $model.settings.display.scale, range: 0.25...1, format: {
                "\(Int(BrowserController.viewport.width * $0))×\(Int(BrowserController.viewport.height * $0))"
            })
            SliderRow(title: "Idle frame rate", value: $model.settings.display.fps, range: 0.2...10, format: { String(format: "%.1f fps", $0) })
            Toggle("Grayscale", isOn: $model.settings.display.grayscale)
            Toggle("Changed-region updates", isOn: $model.settings.display.tiles)
        }
    }

    private var browserSection: some View {
        Section("Browser") {
            LabeledTextField(title: "Host name", text: $model.settings.hostName)
            LabeledTextField(title: "Homepage", text: $model.settings.homepage)
            LabeledTextField(title: "Search URL", text: $model.settings.searchTemplate)
            Button("Clear website data") { model.browser.clearWebsiteData {} }
        }
    }

    private var phoneSection: some View {
        Section {
            Toggle("Keep screen awake", isOn: $model.settings.keepScreenAwake)
            LabeledContent("Network", value: model.network)
            DisclosureGroup("Log", isExpanded: $showLog) {
                ForEach(Array(model.log.reversed().enumerated()), id: \.offset) { _, line in
                    Text(line).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
        } header: {
            Text("This iPhone")
        } footer: {
            Text("PhoneBridge must stay open in the foreground while the Chromebook is connected.")
        }
    }
}

private struct AddressBar: View {
    @ObservedObject var browser: BrowserController
    @State private var address = ""

    var body: some View {
        HStack(spacing: 8) {
            Button { browser.perform("back") } label: { Image(systemName: "chevron.left") }
                .disabled(!browser.canGoBack)
            Button { browser.perform("forward") } label: { Image(systemName: "chevron.right") }
                .disabled(!browser.canGoForward)
            TextField("Search or enter address", text: $address)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.webSearch)
                .submitLabel(.go)
                .onSubmit { browser.navigate(address) }
            Button { browser.perform(browser.isLoading ? "stop" : "reload") } label: {
                Image(systemName: browser.isLoading ? "xmark" : "arrow.clockwise")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .onReceive(browser.$url) { address = $0 }
    }
}

private struct ProgressBar: View {
    @ObservedObject var browser: BrowserController
    var body: some View {
        GeometryReader { g in
            Rectangle().fill(Color.accentColor)
                .frame(width: g.size.width * browser.progress, height: 2)
                .opacity(browser.isLoading ? 1 : 0)
                .animation(.easeOut(duration: 0.2), value: browser.progress)
        }
        .frame(height: 2)
    }
}

private struct SliderRow: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let format: (Double) -> String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack { Text(title); Spacer(); Text(format(value)).foregroundStyle(.secondary).monospacedDigit() }
            Slider(value: $value, in: range)
        }
    }
}

private struct LabeledTextField: View {
    let title: String
    @Binding var text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextField(title, text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
    }
}

struct PairingApprovalView: View {
    let prompt: PairingPrompt
    let answer: (Bool) -> Void

    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "laptopcomputer.and.iphone").font(.system(size: 48)).foregroundStyle(.tint)
            Text("“\(prompt.deviceName)” wants to pair").font(.title3.weight(.semibold)).multilineTextAlignment(.center)
            Text(verbatim: "\(prompt.code.prefix(3)) \(prompt.code.suffix(3))")
                .font(.system(size: 56, weight: .bold, design: .monospaced))
                .accessibilityLabel(prompt.code.map(String.init).joined(separator: " "))
            Text("Type this code on the Chromebook. Tap Approve only after the Chromebook shows “Code verified”.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            HStack(spacing: 16) {
                Button(role: .destructive) { answer(false) } label: { Text("Reject").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
                Button { answer(true) } label: { Text("Approve").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.large)
        }
        .padding(28)
        .presentationDetents([.medium, .large])
    }
}

struct PasswordSheet: View {
    let isChange: Bool
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var first = ""
    @State private var second = ""

    private var valid: Bool { first.count >= 4 && first == second }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("New password", text: $first)
                    SecureField("Confirm", text: $second)
                } footer: {
                    Text("At least 4 characters. Stored on this iPhone only, as a salted PBKDF2 hash in the Keychain.")
                }
            }
            .navigationTitle(isChange ? "Change password" : "Set password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(first); dismiss() }.disabled(!valid)
                }
            }
        }
    }
}
