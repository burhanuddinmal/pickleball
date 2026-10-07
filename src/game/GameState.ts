/** Top-level game states. Later phases add menus, tournament and results states. */
export enum GameStateId {
  LOADING = 'LOADING',
  MAIN_MENU = 'MAIN_MENU',
  SERVING = 'SERVING',
  RALLY = 'RALLY',
  POINT_END = 'POINT_END',
  PAUSED = 'PAUSED',
  MATCH_OVER = 'MATCH_OVER',
}

type Listener = (to: GameStateId, from: GameStateId) => void;

/** Small explicit state machine with a transition table so illegal jumps are caught early. */
export class GameStateMachine {
  private current = GameStateId.LOADING;
  private resumeTo: GameStateId | null = null;
  private listeners: Listener[] = [];

  private static readonly allowed: Record<GameStateId, GameStateId[]> = {
    [GameStateId.LOADING]: [GameStateId.MAIN_MENU],
    [GameStateId.MAIN_MENU]: [GameStateId.SERVING],
    [GameStateId.SERVING]: [GameStateId.RALLY, GameStateId.PAUSED, GameStateId.MAIN_MENU, GameStateId.SERVING],
    [GameStateId.RALLY]: [GameStateId.POINT_END, GameStateId.PAUSED, GameStateId.MAIN_MENU, GameStateId.SERVING],
    [GameStateId.POINT_END]: [GameStateId.SERVING, GameStateId.PAUSED, GameStateId.MAIN_MENU, GameStateId.MATCH_OVER],
    [GameStateId.PAUSED]: [GameStateId.SERVING, GameStateId.RALLY, GameStateId.POINT_END, GameStateId.MAIN_MENU],
    [GameStateId.MATCH_OVER]: [GameStateId.SERVING, GameStateId.MAIN_MENU],
  };

  get state(): GameStateId {
    return this.current;
  }

  get isPaused(): boolean {
    return this.current === GameStateId.PAUSED;
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  go(to: GameStateId): void {
    const from = this.current;
    if (!GameStateMachine.allowed[from].includes(to)) {
      console.warn(`[GameState] illegal transition ${from} -> ${to}`);
      return;
    }
    this.current = to;
    for (const fn of this.listeners) fn(to, from);
  }

  pause(): void {
    if (this.current === GameStateId.PAUSED || this.current === GameStateId.LOADING || this.current === GameStateId.MAIN_MENU || this.current === GameStateId.MATCH_OVER) return;
    this.resumeTo = this.current;
    this.go(GameStateId.PAUSED);
  }

  resume(): void {
    if (this.current !== GameStateId.PAUSED || !this.resumeTo) return;
    const to = this.resumeTo;
    this.resumeTo = null;
    this.go(to);
  }
}
