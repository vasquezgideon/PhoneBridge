import SwiftUI

struct DashboardView: View {
    @EnvironmentObject var model: AppModel
    @State private var showPassword = false
    @State private var editingPassword = false
    @State private var showLog = false

    var body: some View {
        NavigationStack {
            List {
                statusSection
                passwordSection
                activitySection
                settingsSection
            }
            .listStyle(.insetGrouped)
            .navigationTitle("PhoneBridge")
            .sheet(isPresented: $editingPassword) {
                PasswordEditor(current: model.password, generate: model.randomPassword) { model.setPassword($0) }
            }
        }
    }

    private var statusSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: isConnected ? "laptopcomputer.and.iphone" : "antenna.radiowaves.left.and.right")
                    .font(.title2)
                    .foregroundStyle(isConnected ? Color.green : Color.accentColor)
                    .frame(width: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.link.label).font(.headline)
                    Text(model.bluetoothText).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
            if !model.stats.isEmpty {
                Text(model.stats).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            LabeledContent("Internet", value: model.network == "cellular" ? "Cellular" : model.network == "wifi" ? "Wi-Fi" : model.network.capitalized)
        } footer: {
            Text("Keep PhoneBridge open. This iPhone only carries the Chromebook's encrypted network traffic. It doesn't see the pages being visited and can't control the Chromebook.")
        }
    }

    private var isConnected: Bool {
        if case .connected = model.link { return true }
        return false
    }

    private var passwordSection: some View {
        Section {
            HStack {
                Text(showPassword ? model.password : String(repeating: "•", count: model.password.count))
                    .font(.system(.title2, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
                Spacer()
                Button { showPassword.toggle() } label: { Image(systemName: showPassword ? "eye.slash" : "eye") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(showPassword ? "Hide password" : "Show password")
            }
            Button("Change password…") { editingPassword = true }
        } header: {
            Text("Password")
        } footer: {
            Text("Any Chromebook with this password can connect while the app is open. Enter it once in the PhoneBridge extension and tick Remember. 5 wrong tries lock sign-in for 30 s, doubling each time.")
        }
    }

    private var activitySection: some View {
        Section {
            LabeledContent("Open connections", value: "\(model.openConnections)")
            LabeledContent("Downloaded", value: ByteCountFormatter.string(fromByteCount: Int64(model.totalDown), countStyle: .file))
            LabeledContent("Uploaded", value: ByteCountFormatter.string(fromByteCount: Int64(model.totalUp), countStyle: .file))
        } header: {
            Text("Traffic")
        } footer: {
            Text("Byte counts only. Browsing is controlled entirely from the Chromebook.")
        }
    }

    private var settingsSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 2) {
                Text("Name shown on the Chromebook").font(.caption).foregroundStyle(.secondary)
                TextField("iPhone", text: $model.settings.hostName)
            }
            Toggle("Keep screen awake", isOn: $model.settings.keepScreenAwake)
            DisclosureGroup("Log", isExpanded: $showLog) {
                ForEach(Array(model.log.reversed().enumerated()), id: \.offset) { _, line in
                    Text(line).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
        } header: {
            Text("Settings")
        }
    }
}

private struct PasswordEditor: View {
    let current: String
    let generate: () -> String
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    private var valid: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).count >= 4 }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Password", text: $text)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Generate random") { text = generate() }
                } footer: {
                    Text("At least 4 characters; longer is better. Saving signs the current Chromebook out; it will ask for the new password.")
                }
            }
            .navigationTitle("Change password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(text); dismiss() }.disabled(!valid)
                }
            }
            .onAppear { text = current }
        }
    }
}
