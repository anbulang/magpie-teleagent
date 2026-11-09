import fs from 'node:fs'

// ASAR uses a padded Chromium pickle; the file body starts after that padding.
export function writeAsar(asar, files) {
  const entries = {}
  const bodies = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content)
    let node = entries
    const parts = name.split('/')
    for (const part of parts.slice(0, -1)) {
      node[part] ??= { files: {} }
      node = node[part].files
    }
    node[parts.at(-1)] = { size: body.length, offset: String(offset) }
    bodies.push(body)
    offset += body.length
  }
  const header = Buffer.from(JSON.stringify({ files: entries }))
  const pad = (4 - header.length % 4) % 4
  const pickle = Buffer.alloc(16)
  pickle.writeUInt32LE(4, 0)
  pickle.writeUInt32LE(header.length + pad + 8, 4)
  pickle.writeUInt32LE(header.length + pad + 4, 8)
  pickle.writeUInt32LE(header.length, 12)
  fs.writeFileSync(asar, Buffer.concat([pickle, header, Buffer.alloc(pad), ...bodies]))
  return asar
}
