// The state the Studio board mod keeps for its pane. `claude plugin validate` wants this contract
// self-contained, so `state` stays opaque here; hooks/board-model.ts holds its shape (BoardRead).
export type StudioBoardRead =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'ok'; state: object };

declare module 'claude-code' {
  interface PluginState {
    studio: {
      board: Shaped<StudioBoardRead>;
      paused: Shaped<boolean>;
    };
  }
}
