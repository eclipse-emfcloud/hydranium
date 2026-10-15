// The page's status line and log area. A worker has no console anyone reads,
// so what the server logs and the worker reports is shown here.

/** Replace the one-line status in the title bar. */
export function setStatus(text: string): void {
   (document.getElementById('status') as HTMLElement).textContent = text;
}

/** Add a line to the log area, kept scrolled to its end. */
export function appendLog(text: string): void {
   const log = document.getElementById('log') as HTMLElement;
   log.append(`${text}\n`);
   log.scrollTop = log.scrollHeight;
}
