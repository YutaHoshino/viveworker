function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function stripPresentationEnvelopeTags(markdown) {
  return String(markdown ?? "")
    .replace(/^\s*<\/?proposed_plan>\s*$/gimu, "")
    .replace(/<\/?proposed_plan>/giu, "")
    .trim();
}

function sanitizeHref(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  if (/^https?:\/\//iu.test(text) || /^mailto:/iu.test(text) || /^codex:/iu.test(text)) {
    return text;
  }
  if (/^\/(?:approvals|native-approvals|completion-details)\b/u.test(text)) {
    return text;
  }
  return "";
}

function parseAutoLink(text, start) {
  const segment = text.slice(start);
  const match = segment.match(/^(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+|codex:[^\s<>"']+)/iu);
  if (!match) {
    return null;
  }

  let href = match[0];
  while (/[),.;!?]$/u.test(href)) {
    href = href.slice(0, -1);
  }

  const sanitized = sanitizeHref(href);
  if (!sanitized) {
    return null;
  }

  return {
    href: sanitized,
    end: start + href.length,
  };
}

function renderInline(text) {
  let html = "";
  let index = 0;

  while (index < text.length) {
    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        html += `<strong>${renderInline(text.slice(index + 2, end))}</strong>`;
        index = end + 2;
        continue;
      }
    }

    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        html += `<code>${escapeHtml(text.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (text[index] === "[") {
      const link = parseMarkdownLink(text, index);
      if (link) {
        const labelHtml = renderInline(link.label);
        const href = sanitizeHref(link.href);
        html += href
          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${labelHtml}</a>`
          : `${labelHtml} <code>${escapeHtml(link.href)}</code>`;
        index = link.end;
        continue;
      }
    }

    const autoLink = parseAutoLink(text, index);
    if (autoLink) {
      html += `<a href="${escapeHtml(autoLink.href)}" target="_blank" rel="noreferrer">${escapeHtml(autoLink.href)}</a>`;
      index = autoLink.end;
      continue;
    }

    if (text[index] === "*") {
      const end = text.indexOf("*", index + 1);
      if (end > index + 1) {
        const content = text.slice(index + 1, end).trim();
        if (content) {
          html += `<em>${renderInline(content)}</em>`;
          index = end + 1;
          continue;
        }
      }
    }

    html += escapeHtml(text[index]);
    index += 1;
  }

  return html;
}

function parseMarkdownLink(text, start) {
  const closeLabel = text.indexOf("]", start + 1);
  if (closeLabel === -1 || text[closeLabel + 1] !== "(") {
    return null;
  }

  let depth = 1;
  let index = closeLabel + 2;
  while (index < text.length) {
    if (text[index] === "(") {
      depth += 1;
    } else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          label: text.slice(start + 1, closeLabel),
          href: text.slice(closeLabel + 2, index),
          end: index + 1,
        };
      }
    }
    index += 1;
  }

  return null;
}

function isUnorderedList(line) {
  return /^[-*+]\s+/u.test(line);
}

function isOrderedList(line) {
  return /^\d+\.\s+/u.test(line);
}

function isFence(line) {
  return /^```/u.test(line);
}

function renderList(lines, ordered) {
  const tag = ordered ? "ol" : "ul";
  const items = lines
    .map((line) => line.replace(ordered ? /^\d+\.\s+/u : /^[-*+]\s+/u, ""))
    .map((line) => `<li>${renderInline(line.trim())}</li>`)
    .join("");
  return `<${tag}>${items}</${tag}>`;
}

function renderBlockquote(lines) {
  const inner = renderMarkdownHtml(lines.map((line) => line.replace(/^>\s?/u, "")).join("\n"), {
    fallbackHtml: "<p></p>",
  });
  return `<blockquote>${inner}</blockquote>`;
}

function renderCodeBlock(lines) {
  const [fence, ...rest] = lines;
  const language = fence.replace(/^```/u, "").trim();
  const className = language ? ` class="language-${escapeHtml(language)}"` : "";
  return `<pre><code${className}>${escapeHtml(rest.join("\n"))}</code></pre>`;
}

function renderParagraph(lines) {
  return `<p>${lines.map((line) => renderInline(line.trim())).join("<br>")}</p>`;
}

function parseBlocks(markdown) {
  const lines = markdown.replace(/\r\n/gu, "\n").trim().split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (isFence(line)) {
      const block = [line];
      index += 1;
      while (index < lines.length) {
        block.push(lines[index]);
        if (isFence(lines[index])) {
          index += 1;
          break;
        }
        index += 1;
      }
      blocks.push(renderCodeBlock(block));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/u);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^(?:---|\*\*\*|___)\s*$/u.test(line)) {
      blocks.push("<hr>");
      index += 1;
      continue;
    }

    if (/^>\s?/u.test(line)) {
      const block = [];
      while (index < lines.length && /^>\s?/u.test(lines[index])) {
        block.push(lines[index]);
        index += 1;
      }
      blocks.push(renderBlockquote(block));
      continue;
    }

    if (isUnorderedList(line) || isOrderedList(line)) {
      const ordered = isOrderedList(line);
      const block = [];
      while (index < lines.length && (ordered ? isOrderedList(lines[index]) : isUnorderedList(lines[index]))) {
        block.push(lines[index]);
        index += 1;
      }
      blocks.push(renderList(block, ordered));
      continue;
    }

    const block = [];
    while (index < lines.length) {
      const current = lines[index];
      if (!current.trim() || isFence(current) || /^(#{1,6})\s+/u.test(current) || /^>\s?/u.test(current)) {
        break;
      }
      if (isUnorderedList(current) || isOrderedList(current) || /^(?:---|\*\*\*|___)\s*$/u.test(current)) {
        break;
      }
      block.push(current);
      index += 1;
    }
    blocks.push(renderParagraph(block));
  }

  return blocks;
}

export function renderMarkdownHtml(markdown, { fallbackHtml = "<p></p>" } = {}) {
  const normalized = stripPresentationEnvelopeTags(markdown);
  if (!normalized) {
    return fallbackHtml;
  }

  const blocks = parseBlocks(normalized);
  if (blocks.length === 0) {
    return fallbackHtml;
  }

  return blocks.join("\n");
}
