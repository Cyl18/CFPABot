/** 工具契约漂移时 signal 可能是别的对象；不能只靠可选链，先做能力检测再决定是否监听。 */
export function onAbortSignal(signal: AbortSignal | undefined, listener: () => void): () => void {
  if (typeof signal?.addEventListener !== "function") return () => {};
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}
