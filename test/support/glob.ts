/** A minimal Redis-style glob matcher (`*`, `?`, `[...]`, `\` escapes), to check patterns. */
export function globMatch(pattern: string, text: string): boolean {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? ''
    if (char === '\\') source += `\\${pattern[++i] ?? ''}`
    else if (char === '*') source += '[\\s\\S]*'
    else if (char === '?') source += '[\\s\\S]'
    else if (char === '[') {
      const end = pattern.indexOf(']', i + 1)
      source += end === -1 ? '\\[' : `[${pattern.slice(i + 1, end).replace(/\\/g, '\\\\')}]`
      if (end !== -1) i = end
    } else source += char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'u').test(text)
}
