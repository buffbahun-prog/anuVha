type Listener<T> = (payload: T) => void;

export class TypedEmitter<TEvents extends Record<string, any>> {
  private listeners: {
    [K in keyof TEvents]?: Listener<TEvents[K]>[];
  } = {};

  on<K extends keyof TEvents>(event: K, fn: Listener<TEvents[K]>) {
    (this.listeners[event] ||= []).push(fn);
  }

  off<K extends keyof TEvents>(event: K, fn: Listener<TEvents[K]>) {
    this.listeners[event] = this.listeners[event]?.filter(f => f !== fn);
  }

  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]) {
    this.listeners[event]?.forEach(fn => fn(payload));
  }
}