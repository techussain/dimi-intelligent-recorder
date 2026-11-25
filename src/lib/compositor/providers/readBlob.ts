/** Read a Blob into memory (falls back to FileReader where Blob.arrayBuffer is missing). */
export function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((b) => new Uint8Array(b))
  }
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      resolve(new Uint8Array(r.result as ArrayBuffer))
    }
    r.onerror = () => {
      reject(r.error ?? new Error('Could not read the file'))
    }
    r.readAsArrayBuffer(blob)
  })
}
