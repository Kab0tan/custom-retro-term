/** One IPC listener for all tabs, dispatching by pty id. */
type DataHandler = (data: string) => void
type ExitHandler = (code: number) => void

const data = new Map<number, DataHandler>()
const exit = new Map<number, ExitHandler>()
// Output that arrives before its tab has registered (defensive; IPC ordering normally prevents it).
const early = new Map<number, string>()

window.crt.pty.onData((id, chunk) => {
  const h = data.get(id)
  if (h) h(chunk)
  else early.set(id, (early.get(id) ?? '') + chunk)
})
window.crt.pty.onExit((id, code) => exit.get(id)?.(code))

export function subscribePty(id: number, onData: DataHandler, onExit: ExitHandler): () => void {
  data.set(id, onData)
  exit.set(id, onExit)
  const pending = early.get(id)
  if (pending) {
    early.delete(id)
    onData(pending)
  }
  return () => {
    data.delete(id)
    exit.delete(id)
  }
}
