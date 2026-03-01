/**
 * Shared tool-use terminal block logic.
 * Used by both web-ui.html and session-viewer.html.
 *
 * Exports (global functions):
 *   - formatToolLine(text, timeStr) → HTML string for a single terminal line
 *   - makeToolUseBlock()            → DOM element (collapsible terminal block)
 */

/* eslint-disable no-unused-vars */

/**
 * Format a tool execution line with syntax-highlighted segments.
 * Backtick-delimited segments: first = tool name (blue), rest = args (green).
 * Plain text segments shown in green.
 */
function formatToolLine(text, timeStr) {
  var timeEl = '<span class="tl-time">' + timeStr + '</span>';
  var arrowEl = '<span class="tl-arrow">\u25B8</span>';
  var segments = [];
  var regex = /`([^`]*)`/g;
  var match;
  var lastIdx = 0;
  var first = true;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      var plain = text.slice(lastIdx, match.index).trim();
      if (plain) segments.push({ type: 'plain', val: plain });
    }
    if (first) {
      segments.push({ type: 'tool', val: match[1] });
      first = false;
    } else {
      segments.push({ type: 'arg', val: match[1] });
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    var remainder = text.slice(lastIdx).trim();
    if (remainder) segments.push({ type: first ? 'tool' : 'plain', val: remainder });
  }

  if (segments.length === 0) {
    segments.push({ type: 'plain', val: text });
  }

  var contentHtml = segments.map(function(s) {
    var escaped = s.val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (s.type === 'tool') return '<span class="tl-tool">' + escaped + '</span>';
    if (s.type === 'arg')  return '<span class="tl-arg">' + escaped + '</span>';
    return '<span class="tl-plain">' + escaped + '</span>';
  }).join(' ');

  return timeEl + arrowEl + contentHtml;
}

/**
 * Create a new collapsible terminal block element.
 * Minimizes all existing blocks and returns the new (expanded) block.
 */
function makeToolUseBlock() {
  // Minimize all existing tool blocks
  var existing = document.querySelectorAll('.tool-use-block');
  for (var i = 0; i < existing.length; i++) {
    existing[i].classList.add('minimized');
  }

  var block = document.createElement('div');
  block.className = 'tool-use-block';
  block.innerHTML =
    '<div class="terminal-header">' +
      '<div class="terminal-title">ferramentas</div>' +
      '<div class="terminal-toggle">\u25BE</div>' +
    '</div>' +
    '<div class="terminal-body"></div>';

  var header = block.querySelector('.terminal-header');
  header.addEventListener('click', function() {
    if (block.classList.contains('minimized')) {
      // Expand this one, minimize all others
      var all = document.querySelectorAll('.tool-use-block');
      for (var j = 0; j < all.length; j++) all[j].classList.add('minimized');
      block.classList.remove('minimized');
    } else {
      block.classList.add('minimized');
    }
  });

  return block;
}
