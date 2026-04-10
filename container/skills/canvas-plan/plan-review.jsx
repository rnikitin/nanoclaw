function App({ state, send, theme }) {
  const T = theme;
  const [comments, setComments] = useState({});
  const [activeComment, setActiveComment] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [expandedComments, setExpandedComments] = useState({});
  const textareaRef = useRef(null);

  const md = state.markdown || '';

  const parseMarkdown = (text) => {
    const sections = [];
    let current = { id: 'header', lines: [] };
    text.split('\n').forEach((line, idx) => {
      if (/^#{1,3}\s/.test(line)) {
        if (current.lines.length > 0 || current.title) sections.push(current);
        const level = (line.match(/^#+/) || [''])[0].length;
        const title = line.replace(/^#+\s*/, '');
        current = { id: `s${idx}`, title, level, lines: [] };
      } else {
        current.lines.push(line);
      }
    });
    if (current.lines.length > 0 || current.title) sections.push(current);
    return sections;
  };

  const renderTable = (tableLines) => {
    const rows = tableLines.map(l => l.split('|').map(c => c.trim()).filter(c => c !== ''));
    if (rows.length < 2) return '';
    const header = rows[0];
    const dataRows = rows.filter((_, i) => i >= 2);
    return `<div style="overflow-x:auto;margin:12px 0"><table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr>${header.map(h => `<th style="text-align:left;padding:8px 12px;border-bottom:1px solid ${T.border};color:${T.textHeading3};font-weight:600;white-space:nowrap">${h}</th>`).join('')}</tr></thead>
      <tbody>${dataRows.map(r => `<tr>${r.map(c => `<td style="padding:6px 12px;border-bottom:1px solid ${T.borderLight};color:${T.textBody}">${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  };

  const renderText = (text) => {
    if (!text.trim()) return '';
    // Handle tables first
    const lines = text.split('\n');
    const parts = [];
    let tableBuffer = [];
    let inTable = false;

    for (const line of lines) {
      const isTableLine = /^\|.+\|$/.test(line.trim());
      if (isTableLine) {
        inTable = true;
        tableBuffer.push(line);
      } else {
        if (inTable) {
          parts.push(renderTable(tableBuffer));
          tableBuffer = [];
          inTable = false;
        }
        parts.push(line);
      }
    }
    if (inTable) parts.push(renderTable(tableBuffer));

    return parts.join('\n')
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
        `<pre style="background:${T.codeBg};padding:14px 16px;border-radius:${T.radius}px;overflow-x:auto;font-size:${T.codeFontSize}px;line-height:1.6;margin:12px 0;border:1px solid ${T.codeBorder};white-space:pre-wrap;word-break:break-word;color:${T.textHeading3}"><code>${code}</code></pre>`)
      .replace(/`([^`]+)`/g, `<code style="background:${T.codeInlineBg};padding:2px 6px;border-radius:4px;font-size:${T.codeFontSize}px;color:${T.codeInlineColor}">$1</code>`)
      .replace(/\*\*(.+?)\*\*/g, `<strong style="color:${T.textHeading2};font-weight:500">$1</strong>`)
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^- \[x\] (.+)$/gm, `<div style="margin:4px 0;padding-left:4px;color:${T.textDim}"><span style="color:${T.approve};margin-right:8px">✓</span><s>$1</s></div>`)
      .replace(/^- \[ \] (.+)$/gm, `<div style="margin:4px 0;padding-left:4px"><span style="color:${T.textDimmer};margin-right:8px">○</span>$1</div>`)
      .replace(/^- (.+)$/gm, `<div style="margin:4px 0;padding-left:4px"><span style="color:${T.textDimmer};margin-right:8px">•</span>$1</div>`)
      .replace(/^\d+\. (.+)$/gm, (m, p1) =>
        `<div style="margin:4px 0;padding-left:4px"><span style="color:${T.textDim};margin-right:8px;font-variant-numeric:tabular-nums">${m.match(/^\d+/)[0]}.</span>${p1}</div>`)
      .replace(/\n\n/g, '<div style="height:12px"></div>')
      .replace(/\n/g, '<br/>');
  };

  const sections = parseMarkdown(md);

  const addComment = (sectionId) => {
    if (!commentText.trim()) return;
    const existing = comments[sectionId] || [];
    setComments({ ...comments, [sectionId]: [...existing, commentText.trim()] });
    setCommentText('');
    setActiveComment(null);
    setExpandedComments({ ...expandedComments, [sectionId]: true });
  };

  const removeComment = (sectionId, idx) => {
    const existing = [...(comments[sectionId] || [])];
    existing.splice(idx, 1);
    const next = { ...comments };
    if (existing.length === 0) delete next[sectionId];
    else next[sectionId] = existing;
    setComments(next);
  };

  const openComment = (sectionId) => {
    setActiveComment(sectionId);
    setCommentText('');
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const totalComments = Object.values(comments).reduce((sum, arr) => sum + arr.length, 0);

  const handleSubmit = () => {
    const feedback = [];
    sections.forEach(s => {
      const c = comments[s.id];
      if (c && c.length > 0) feedback.push({ section: s.title || 'Header', text: s.lines.join('\n').trim(), comments: c });
    });
    send({ type: 'submit', feedback, totalComments });
    setSubmitted(true);
  };

  const handleApprove = () => {
    send({ type: 'approve' });
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div style={{ maxWidth: 480, margin: '100px auto', padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 24 }}>{totalComments > 0 ? '📝' : '✅'}</div>
        <h2 style={{ fontSize: 20, marginBottom: 8, color: T.textHeading, fontWeight: 600, letterSpacing: T.letterSpacing }}>
          {totalComments > 0 ? 'Feedback sent' : 'Plan approved'}
        </h2>
        <p style={{ color: T.textMuted, fontSize: 14, lineHeight: 1.6 }}>
          {totalComments > 0
            ? `${totalComments} comment${totalComments > 1 ? 's' : ''} sent. The plan will be revised.`
            : 'The agent will proceed with this plan.'}
        </p>
      </div>
    );
  }

  const headingStyle = (level, si) => ({
    fontSize: level === 1 ? T.h1Size : level === 2 ? T.h2Size : T.h3Size,
    fontWeight: level === 1 ? 700 : 600,
    color: level === 1 ? T.textHeading : level === 2 ? T.textHeading2 : T.textHeading3,
    margin: level === 1 ? (si === 0 ? '0 0 4px' : '36px 0 4px') : level === 2 ? '32px 0 4px' : '24px 0 4px',
    letterSpacing: T.letterSpacing,
    lineHeight: 1.3,
  });

  const commentBtnTop = (level, si) =>
    level === 1 ? (si === 0 ? 6 : 40) : level === 2 ? 36 : 28;

  return (
    <div style={{ maxWidth: T.maxWidth, margin: '0 auto', padding: T.containerPadding, fontFamily: T.fontFamily, lineHeight: T.lineHeight, color: T.text, WebkitTextSizeAdjust: '100%', fontSize: T.fontSize }}>

      {sections.map((section, si) => {
        const sc = comments[section.id] || [];
        const isActive = activeComment === section.id;
        const isExpanded = expandedComments[section.id];
        const hasComments = sc.length > 0;
        const H = section.level === 1 ? 'h1' : section.level === 2 ? 'h2' : 'h3';
        const content = section.lines.join('\n').trim();

        return (
          <div key={section.id} style={{ position: 'relative', padding: T.sectionPadding, borderBottom: section.level <= 2 && si < sections.length - 1 ? `1px solid ${T.sectionBorder}` : 'none' }}>

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ flex: 1 }}>
                {section.title && <H style={headingStyle(section.level, si)}>{section.title}</H>}
              </div>

              {hasComments ? (
                <button onClick={() => setExpandedComments({ ...expandedComments, [section.id]: !isExpanded })}
                  style={{ marginTop: commentBtnTop(section.level, si), background: T.orangeLight, color: T.orange, border: 'none', borderRadius: 20, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 28, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, transition: T.transition }}>
                  💬 {sc.length}
                </button>
              ) : section.title ? (
                <button onClick={() => openComment(section.id)}
                  style={{ marginTop: commentBtnTop(section.level, si), background: 'transparent', color: T.addBtnColor, border: `1px dashed ${T.addBtnBorder}`, borderRadius: T.radius, width: 28, height: 28, cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: T.transition, WebkitTapHighlightColor: 'transparent' }}>
                  +
                </button>
              ) : null}
            </div>

            {content && (
              <div style={{ fontSize: T.fontSize, wordBreak: 'break-word', overflowWrap: 'break-word', color: T.textBody, marginTop: 6 }}
                dangerouslySetInnerHTML={{ __html: renderText(content) }} />
            )}

            {!section.title && !hasComments && content && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                <button onClick={() => openComment(section.id)}
                  style={{ background: 'transparent', color: T.addBtnColor, border: `1px dashed ${T.addBtnBorder}`, borderRadius: T.radius, width: 28, height: 28, cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', WebkitTapHighlightColor: 'transparent' }}>
                  +
                </button>
              </div>
            )}

            {isExpanded && sc.map((c, idx) => (
              <div key={idx} style={{ background: T.commentCardBg, border: `1px solid ${T.commentCardBorder}`, padding: '10px 14px', margin: '10px 0 0', borderRadius: T.radius, fontSize: 13, display: 'flex', gap: 10, alignItems: 'flex-start', lineHeight: 1.6 }}>
                <span style={{ color: T.orange, fontSize: 13, flexShrink: 0, marginTop: 2 }}>💬</span>
                <span style={{ flex: 1, wordBreak: 'break-word', color: T.textHeading3 }}>{c}</span>
                <button onClick={() => removeComment(section.id, idx)}
                  style={{ background: 'none', border: 'none', color: T.textDim, cursor: 'pointer', fontSize: 16, padding: 0, minWidth: 32, minHeight: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: T.transition }}>×</button>
              </div>
            ))}

            {isExpanded && sc.length > 0 && !isActive && (
              <button onClick={() => openComment(section.id)}
                style={{ marginTop: 8, padding: '6px 12px', fontSize: 12, color: T.orange, background: 'transparent', border: `1px solid ${T.commentCardBorder}`, borderRadius: T.radiusSm, cursor: 'pointer', minHeight: 32, transition: T.transition }}>
                + add another
              </button>
            )}

            {isActive && (
              <div style={{ margin: '12px 0 0', padding: 14, background: T.commentBoxBg, borderRadius: T.radiusLg, border: `1px solid ${T.commentBoxBorder}` }}>
                <textarea ref={textareaRef}
                  placeholder="Your comment on this section..."
                  value={commentText}
                  onChange={e => {
                    setCommentText(e.target.value);
                    const el = e.target;
                    el.style.height = '0';
                    const sh = el.scrollHeight;
                    el.style.height = Math.min(sh, T.textareaMaxHeight) + 'px';
                    el.style.overflowY = sh > T.textareaMaxHeight ? 'auto' : 'hidden';
                  }}
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addComment(section.id); }}
                  rows={1}
                  style={{ width: '100%', minHeight: T.minTouchTarget, background: T.inputBg, color: T.textHeading2, border: `1px solid ${T.inputBorder}`, borderRadius: T.radius, padding: '10px 12px', fontSize: 14, resize: 'none', fontFamily: 'inherit', boxSizing: 'border-box', WebkitAppearance: 'none', lineHeight: 1.6, outline: 'none', overflowY: 'hidden', transition: 'border-color 0.15s' }}
                  onFocus={e => e.target.style.borderColor = T.accent}
                  onBlur={e => e.target.style.borderColor = T.inputBorder}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => { setActiveComment(null); setCommentText(''); }}
                    style={{ padding: '8px 16px', fontSize: 13, background: 'transparent', color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: T.radius, cursor: 'pointer', minHeight: T.btnHeight, transition: T.transition, fontWeight: 500 }}>
                    Cancel
                  </button>
                  <button onClick={() => addComment(section.id)}
                    style={{ padding: '8px 20px', fontSize: 13, background: commentText.trim() ? T.accent : T.bgMuted, color: commentText.trim() ? '#fff' : T.textDim, border: 'none', borderRadius: T.radius, cursor: commentText.trim() ? 'pointer' : 'default', minHeight: T.btnHeight, fontWeight: 500, transition: T.transition }}>
                    Comment
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
        background: `linear-gradient(to top, ${T.bg} 70%, ${T.bg}00)`,
        padding: '24px 20px 0',
        paddingBottom: 'max(16px, env(safe-area-inset-bottom))'
      }}>
        <div style={{ maxWidth: T.maxWidth, margin: '0 auto', display: 'flex', gap: 10 }}>
          {totalComments > 0 ? (
            <>
              <button onClick={handleApprove}
                style={{ flex: 1, padding: '12px 16px', fontSize: 14, fontWeight: 500, background: 'transparent', color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: T.radiusLg, cursor: 'pointer', minHeight: T.bottomBarHeight, transition: T.transition }}>
                Approve as is
              </button>
              <button onClick={handleSubmit}
                style={{ flex: 2, padding: '12px 16px', fontSize: 14, fontWeight: 600, background: T.accent, color: '#fff', border: 'none', borderRadius: T.radiusLg, cursor: 'pointer', minHeight: T.bottomBarHeight, boxShadow: `0 4px 14px ${T.accentShadow}`, transition: T.transition }}>
                Submit {totalComments} comment{totalComments !== 1 ? 's' : ''} →
              </button>
            </>
          ) : (
            <button onClick={handleApprove}
              style={{ flex: 1, padding: '12px 16px', fontSize: 14, fontWeight: 500, background: T.accent, color: '#fff', border: 'none', borderRadius: T.radius, cursor: 'pointer', minHeight: T.bottomBarHeight, transition: T.transition, letterSpacing: '-0.01em' }}>
              Approve plan
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
