/**
 * Turns the simple text format used for guides and test write-ups into safe HTML:
 *   blank line = new paragraph · "## Heading" · "### Smaller heading" · "- list item" · **bold**
 * Everything is escaped first, so no HTML or scripts can be added this way.
 */
const escape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const inline = (s) => escape(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

function render(text) {
  const blocks = String(text || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    if (block.startsWith('### ')) return `<h3>${inline(block.slice(4))}</h3>`;
    if (block.startsWith('## ')) return `<h2>${inline(block.slice(3))}</h2>`;
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*-\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*-\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('\n');
}

/** Plain text for descriptions: no markers, single spaces. */
const plain = (text) => String(text || '').replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/^\s*-\s+/gm, '').replace(/\s+/g, ' ').trim();

module.exports = { render, plain, escape };
