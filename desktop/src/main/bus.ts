/** 主进程内部事件总线：避免 device / download 模块反向依赖 ipc 造成循环引用。 */
type Listener = (type: string, data: unknown) => void;

let listener: Listener | null = null;

export function setEmitter(next: Listener | null): void {
  listener = next;
}

export function emitEvent(type: string, data: unknown): void {
  listener?.(type, data);
}
