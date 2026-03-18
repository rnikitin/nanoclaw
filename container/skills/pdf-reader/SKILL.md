---
name: pdf-reader
description: Extract text from PDF files — local files, URLs, or attachments sent via messaging channels. Use whenever you need to read, summarize, or analyze a PDF document.
allowed-tools: Bash(pdf-reader:*)
---

# PDF Reader

## Quick start

```bash
pdf-reader extract report.pdf          # Extract all text
pdf-reader extract report.pdf 1-5      # Extract pages 1–5
pdf-reader info report.pdf             # Page count, metadata
pdf-reader fetch https://example.com/doc.pdf  # Download and extract
```

## Commands

### extract — Extract text from a local PDF

```bash
pdf-reader extract <file>              # All pages
pdf-reader extract <file> 1-5          # Page range
pdf-reader extract <file> 3            # Single page
```

### info — Show PDF metadata

```bash
pdf-reader info <file>                 # Page count, title, author, etc.
```

### fetch — Download a PDF from URL and extract text

```bash
pdf-reader fetch <url>                 # Download + extract all pages
pdf-reader fetch <url> 1-5             # Download + extract page range
```

## Attachments from messaging channels

When a user sends a PDF via Telegram or WhatsApp, it is automatically downloaded to `/workspace/group/attachments/`. The message will contain the path:

```
[PDF: report.pdf → /workspace/group/attachments/report.pdf]
```

Read it with:

```bash
pdf-reader extract /workspace/group/attachments/report.pdf
```
