import AppKit
import EventKit
import Foundation

private struct CalendarRow: Codable {
    let title: String
    let start: Double
    let allDay: Bool
    let calendar: String
}

private struct ReaderOutput: Codable {
    let ok: Bool
    let events: [CalendarRow]
    let error: String?
    let authorizationStatus: Int
}

private enum ReaderError: LocalizedError {
    case invalidArguments
    case accessDenied

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "Calendar reader received invalid arguments"
        case .accessDenied:
            return "Full Apple Calendar access was not granted"
        }
    }
}

@main
private struct CalendarReader {
    @MainActor
    static func main() async {
        _ = NSApplication.shared
        NSApplication.shared.setActivationPolicy(.accessory)
        NSApplication.shared.activate(ignoringOtherApps: true)
        let arguments = CommandLine.arguments
        guard let outputPath = value(after: "--output", in: arguments) else {
            fputs("Missing --output\n", stderr)
            Foundation.exit(2)
        }

        let output: ReaderOutput
        do {
            guard
                let fromText = value(after: "--from", in: arguments),
                let untilText = value(after: "--until", in: arguments),
                let fromMilliseconds = Double(fromText),
                let untilMilliseconds = Double(untilText)
            else { throw ReaderError.invalidArguments }
            let store = EKEventStore()
            try await ensureCalendarAccess(store)
            let calendars = store.calendars(for: .event)
            let predicate = store.predicateForEvents(
                withStart: Date(timeIntervalSince1970: fromMilliseconds / 1_000),
                end: Date(timeIntervalSince1970: untilMilliseconds / 1_000),
                calendars: calendars
            )
            let events = store.events(matching: predicate).map { event in
                CalendarRow(
                    title: event.title ?? "",
                    start: event.startDate.timeIntervalSince1970 * 1_000,
                    allDay: event.isAllDay,
                    calendar: event.calendar.title
                )
            }
            output = ReaderOutput(
                ok: true,
                events: events,
                error: nil,
                authorizationStatus: EKEventStore.authorizationStatus(for: .event).rawValue
            )
        } catch {
            output = ReaderOutput(
                ok: false,
                events: [],
                error: error.localizedDescription,
                authorizationStatus: EKEventStore.authorizationStatus(for: .event).rawValue
            )
        }

        do {
            let data = try JSONEncoder().encode(output)
            try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
        } catch {
            fputs("Could not write Calendar reader result: \(error.localizedDescription)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func ensureCalendarAccess(_ store: EKEventStore) async throws {
        let status = EKEventStore.authorizationStatus(for: .event)
        if status.rawValue == 3 { return }
        guard status == .notDetermined else { throw ReaderError.accessDenied }

        let granted: Bool
        if #available(macOS 14.0, *) {
            granted = try await store.requestFullAccessToEvents()
        } else {
            granted = try await withCheckedThrowingContinuation { continuation in
                store.requestAccess(to: .event) { allowed, error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume(returning: allowed) }
                }
            }
        }
        guard granted else { throw ReaderError.accessDenied }
    }

    private static func value(after name: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }
}
