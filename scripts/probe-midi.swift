import CoreMIDI
import Foundation

func property(_ object: MIDIObjectRef, _ key: CFString) -> String {
    var value: Unmanaged<CFString>?
    let status = MIDIObjectGetStringProperty(object, key, &value)
    guard status == noErr, let value else {
        return "(unnamed)"
    }
    return value.takeRetainedValue() as String
}

func describe(_ endpoint: MIDIEndpointRef) -> String {
    let name = property(endpoint, kMIDIPropertyDisplayName)
    var manufacturer: Unmanaged<CFString>?
    MIDIObjectGetStringProperty(endpoint, kMIDIPropertyManufacturer, &manufacturer)
    let maker = manufacturer?.takeRetainedValue() as String? ?? "(unknown maker)"
    return "\(name) — \(maker)"
}

print("Sources (\(MIDIGetNumberOfSources()))")
for index in 0..<MIDIGetNumberOfSources() {
    print("  [\(index)] \(describe(MIDIGetSource(index)))")
}

print("Destinations (\(MIDIGetNumberOfDestinations()))")
for index in 0..<MIDIGetNumberOfDestinations() {
    print("  [\(index)] \(describe(MIDIGetDestination(index)))")
}
