function App({ state, send }) {
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

  const renderText = (text) => {
    if (!text.trim()) return '';
    return text
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
        `<pre style="background:#161625;padding:14px 16px;border-radius:8px;overflow-x:auto;font-size:12.5px;line-height:1.5;margin:10px 0;border:1px solid #2a2a3e;white-space:pre-wrap;word-break:break-word"><code>${code}</code></pre>`)
      .replace(/`([^`]+)`/g, '<code style="background:#2a2a3e;padding:2px 6px;border-radius:4px;font-size:12.5px;color:#7ec8e3">$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#fff">$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^- \[x\] (.+)$/gm, '<div style="margin:3px 0;padding-left:4px;color:#888"><span style="color:#2ecc71;margin-right:6px">✓</span><s>$1</s></div>')
      .replace(/^- \[ \] (.+)$/gm, '<div style="margin:3px 0;padding-left:4px"><span style="color:#555;margin-right:6px">○</span>$1</div>')
      .replace(/^- (.+)$/gm, '<div style="margin:3px 0;padding-left:4px"><span style="color:#555;margin-right:8px">•</span>$1</div>')
      .replace(/^\d+\. (.+)$/gm, (m, p1) =>
        '<div style="margin:3px 0;padding-left:4px"><span style="color:#666;margin-right:8px">' + m.match(/^\d+/)[0] + '.</span>' + p1 + '</div>')
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
      if (c && c.length > 0) feedback.push({ section: s.title || 'Header', comments: c });
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
      <div style={{ maxWidth: 600, margin: '80px auto', padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 56, marginBottom: 20 }}>{totalComments > 0 ? '📝' : '✅'}</div>
        <h2 style={{ fontSize: 22, marginBottom: 10, color: '#fff' }}>
          {totalComments > 0 ? 'Feedback sent' : 'Plan approved'}
        </h2>
        <p style={{ color: '#777', fontSize: 15, lineHeight: 1.5 }}>
          {totalComments > 0
            ? `${totalComments} comment${totalComments > 1 ? 's' : ''} sent. The plan will be revised.`
            : 'The agent will proceed with this plan.'}
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '24px 16px 140px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', lineHeight: 1.7, color: '#ccc', WebkitTextSizeAdjust: '100%', fontSize: 14.5 }}>

      {sections.map((section, si) => {
        const sc = comments[section.id] || [];
        const isActive = activeComment === section.id;
        const isExpanded = expandedComments[section.id];
        const hasComments = sc.length > 0;

        const heading = section.level === 1
          ? { el: 'h1', style: { fontSize: 24, fontWeight: 700, color: '#fff', margin: si === 0 ? '0 0 2px' : '32px 0 2px', letterSpacing: '-0.3px' } }
          : section.level === 2
          ? { el: 'h2', style: { fontSize: 19, fontWeight: 600, color: '#eee', margin: '28px 0 2px', letterSpacing: '-0.2px' } }
          : { el: 'h3', style: { fontSize: 16, fontWeight: 600, color: '#ddd', margin: '22px 0 2px' } };

        const H = heading.el;
        const content = section.lines.join('\n').trim();

        return (
          <div key={section.id} style={{ position: 'relative', padding: '6px 0', borderBottom: section.level <= 2 && si < sections.length - 1 ? '1px solid #ffffff08' : 'none' }}>

            {/* Section header row */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1 }}>
                {section.title && <H style={heading.style}>{section.title}</H>}
              </div>

              {/* Comment action button */}
              {hasComments ? (
                <button onClick={() => setExpandedComments({ ...expandedComments, [section.id]: !isExpanded })}
                  style={{ marginTop: section.level === 1 ? (si === 0 ? 4 : 36) : section.level === 2 ? 32 : 26, background: '#e67e22', color: '#fff', border: 'none', borderRadius: 12, padding: '3px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 28, minWidth: 28, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, transition: 'transform 0.15s', transform: isExpanded ? 'scale(1.05)' : 'scale(1)' }}>
                  💬 {sc.length}
                </button>
              ) : section.title ? (
                <button onClick={() => openComment(section.id)}
                  style={{ marginTop: section.level === 1 ? (si === 0 ? 4 : 36) : section.level === 2 ? 32 : 26, background: 'transparent', color: '#555', border: '1.5px dashed #333', borderRadius: 8, width: 28, height: 28, cursor: 'pointer', fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.15s', WebkitTapHighlightColor: 'transparent' }}>
                  +
                </button>
              ) : null}
            </div>

            {/* Content */}
            {content && (
              <div style={{ fontSize: 14.5, wordBreak: 'break-word', overflowWrap: 'break-word', color: '#bbb', marginTop: 4 }}
                dangerouslySetInnerHTML={{ __html: renderText(content) }} />
            )}

            {/* No-title sections get comment button after content */}
            {!section.title && !hasComments && content && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                <button onClick={() => openComment(section.id)}
                  style={{ background: 'transparent', color: '#555', border: '1.5px dashed #333', borderRadius: 8, width: 28, height: 28, cursor: 'pointer', fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', WebkitTapHighlightColor: 'transparent' }}>
                  +
                </button>
              </div>
            )}

            {/* Comments list */}
            {isExpanded && sc.map((c, idx) => (
              <div key={idx} style={{ background: '#1c1510', border: '1px solid #e67e2233', padding: '10px 12px', margin: '8px 0 0', borderRadius: 8, fontSize: 13.5, display: 'flex', gap: 10, alignItems: 'flex-start', lineHeight: 1.5 }}>
                <span style={{ color: '#e67e22', fontSize: 14, flexShrink: 0, marginTop: 1 }}>💬</span>
                <span style={{ flex: 1, wordBreak: 'break-word', color: '#ddd' }}>{c}</span>
                <button onClick={() => removeComment(section.id, idx)}
                  style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16, padding: 0, minWidth: 32, minHeight: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>×</button>
              </div>
            ))}

            {isExpanded && sc.length > 0 && !isActive && (
              <button onClick={() => openComment(section.id)}
                style={{ marginTop: 6, padding: '6px 12px', fontSize: 12, color: '#e67e22', background: 'transparent', border: '1px solid #e67e2244', borderRadius: 6, cursor: 'pointer', minHeight: 32 }}>
                + add another
              </button>
            )}

            {/* Comment input */}
            {isActive && (
              <div style={{ margin: '10px 0 0', padding: 12, background: '#13131f', borderRadius: 10, border: '1px solid #3498db55' }}>
                <textarea ref={textareaRef}
                  placeholder="Your comment on this section..."
                  value={commentText}
                  onChange={e => setCommentText(e.target.value)}
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addComment(section.id); }}
                  rows={2}
                  style={{ width: '100%', background: '#0d0d18', color: '#e0e0e0', border: '1px solid #2a2a3e', borderRadius: 8, padding: '10px 12px', fontSize: 15, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box', WebkitAppearance: 'none', lineHeight: 1.5, outline: 'none' }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => { setActiveComment(null); setCommentText(''); }}
                    style={{ padding: '8px 16px', fontSize: 14, background: 'transparent', color: '#888', border: '1px solid #333', borderRadius: 8, cursor: 'pointer', minHeight: 38 }}>
                    Cancel
                  </button>
                  <button onClick={() => addComment(section.id)}
                    style={{ padding: '8px 20px', fontSize: 14, background: commentText.trim() ? '#3498db' : '#333', color: commentText.trim() ? '#fff' : '#666', border: 'none', borderRadius: 8, cursor: commentText.trim() ? 'pointer' : 'default', minHeight: 38, fontWeight: 500, transition: 'all 0.15s' }}>
                    Comment
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Bottom action bar */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
        background: 'linear-gradient(to top, #111119 80%, #11111900)',
        padding: '20px 16px 0',
        paddingBottom: 'max(16px, env(safe-area-inset-bottom))'
      }}>
        <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', gap: 10 }}>
          {totalComments > 0 ? (
            <>
              <button onClick={handleApprove}
                style={{ flex: 1, padding: '14px 16px', fontSize: 15, fontWeight: 500, background: 'transparent', color: '#888', border: '1px solid #333', borderRadius: 10, cursor: 'pointer', minHeight: 48 }}>
                Approve as is
              </button>
              <button onClick={handleSubmit}
                style={{ flex: 2, padding: '14px 16px', fontSize: 15, fontWeight: 600, background: '#3498db', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', minHeight: 48, boxShadow: '0 4px 12px #3498db33' }}>
                Submit {totalComments} comment{totalComments !== 1 ? 's' : ''} →
              </button>
            </>
          ) : (
            <button onClick={handleApprove}
              style={{ flex: 1, padding: '14px 16px', fontSize: 15, fontWeight: 600, background: '#2ecc71', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', minHeight: 48, boxShadow: '0 4px 12px #2ecc7133' }}>
              Approve plan ✓
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
