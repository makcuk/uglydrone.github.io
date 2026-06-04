const fs = require('fs');
const path = require('path');

// Target directories and files
const WORKSPACE_DIR = __dirname;
const POSTS_DIR = path.join(WORKSPACE_DIR, 'posts');
const TEMPLATES_DIR = path.join(WORKSPACE_DIR, 'templates');
const LAYOUT_PATH = path.join(TEMPLATES_DIR, 'layout.html');
const ABOUT_CONTENT_PATH = path.join(TEMPLATES_DIR, 'about_content.html');
const INDEX_OUTPUT_PATH = path.join(WORKSPACE_DIR, 'index.html');
const ABOUT_OUTPUT_PATH = path.join(WORKSPACE_DIR, 'about.html');

console.log('Starting UglyDrone static site generation...');

// Ensure layout and directories exist
if (!fs.existsSync(LAYOUT_PATH)) {
  console.error(`Layout template not found at ${LAYOUT_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(ABOUT_CONTENT_PATH)) {
  console.error(`About content not found at ${ABOUT_CONTENT_PATH}`);
  process.exit(1);
}

const layoutTemplate = fs.readFileSync(LAYOUT_PATH, 'utf-8');

/**
 * Parses frontmatter metadata and returns metadata and raw body content
 * Supports --- wrapped YAML style
 */
function parsePost(content) {
  const match = content.match(/^---([\s\S]*?)---\n?/);
  if (!match) {
    return { data: {}, body: content };
  }
  
  const rawYaml = match[1];
  const body = content.slice(match[0].length);
  const data = {};
  
  rawYaml.split('\n').forEach(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      let val = line.slice(colonIdx + 1).trim();
      // Remove surrounding quotes if any
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      data[key] = val;
    }
  });
  
  return { data, body };
}

/**
 * Extracts a preview of the blog post.
 * Uses <!-- more --> if present, otherwise takes first 8 non-empty lines.
 */
function extractPreview(body) {
  if (body.includes('<!-- more -->')) {
    return body.split('<!-- more -->')[0].trim();
  }
  
  const lines = body.split('\n');
  const previewLines = [];
  let nonSpaceLineCount = 0;
  
  for (const line of lines) {
    if (line.trim().length > 0) {
      previewLines.push(line);
      nonSpaceLineCount++;
      if (nonSpaceLineCount >= 8) {
        break;
      }
    } else if (previewLines.length > 0) {
      // Preserve internal empty lines to maintain paragraph flow
      previewLines.push(line);
    }
  }
  
  return previewLines.join('\n').trim();
}

/**
 * A highly robust, zero-dependency Markdown-to-HTML parser
 */
function markdownToHtml(md) {
  let html = md;

  // Escape HTML characters to avoid rendering issues with markup in code/text
  // But preserve comments like <!-- more -->
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  // Restore <!-- more --> if it was escaped
  html = html.replace(/&lt;!--\s*more\s*--&gt;/g, '<!-- more -->');

  // 1. Extract and stash fenced code blocks (```lang ... ```)
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    // Restore escaped code block contents if they were escaped during the HTML escape phase
    const restoredCode = code
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'");
      
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(`<pre><code class="language-${lang}">${restoredCode.trim()}</code></pre>`);
    return placeholder;
  });

  // 2. Extract and stash inline code (`code`)
  const inlineCodes = [];
  html = html.replace(/`([^`\n]+)`/g, (match, code) => {
    const placeholder = `__INLINE_CODE_${inlineCodes.length}__`;
    inlineCodes.push(`<code>${code}</code>`);
    return placeholder;
  });

  // 3. Process headings
  html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');

  // 4. Process bold & italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // 5. Process links & images
  // Image: ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%; height:auto; border-radius:12px; margin: 16px 0; border: 1px solid var(--border); box-shadow: var(--shadow);" />');
  // Link: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 6. Process blockquotes
  html = html.replace(/^&gt;\s?(.*?)$/gm, '<blockquote>$1</blockquote>');

  // 7. Parse line-by-line for paragraphs and list groups
  const lines = html.split('\n');
  const processedLines = [];
  let inList = false;
  let listType = null; // 'ul' or 'ol'

  for (let line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') {
      if (inList) {
        processedLines.push(`</${listType}>`);
        inList = false;
        listType = null;
      }
      continue;
    }

    // Unordered lists (- or *)
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList || listType !== 'ul') {
        if (inList) processedLines.push(`</${listType}>`);
        processedLines.push('<ul style="margin: 10px 0; padding-left: 20px; line-height: 1.7;">');
        inList = true;
        listType = 'ul';
      }
      processedLines.push(`<li style="margin-bottom: 8px;">${trimmed.substring(2)}</li>`);
      continue;
    }

    // Ordered lists (1., 2.)
    const olMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) processedLines.push(`</${listType}>`);
        processedLines.push('<ol style="margin: 10px 0; padding-left: 20px; line-height: 1.7;">');
        inList = true;
        listType = 'ol';
      }
      processedLines.push(`<li style="margin-bottom: 8px;">${olMatch[2]}</li>`);
      continue;
    }

    // Skip page breaks / comments from being rendered in full HTML
    if (trimmed === '<!-- more -->' || trimmed === '<!--more-->') {
      continue;
    }

    // Structural elements that shouldn't be wrapped in paragraphs
    if (
      trimmed.startsWith('<h1>') ||
      trimmed.startsWith('<h2>') ||
      trimmed.startsWith('<h3>') ||
      trimmed.startsWith('<blockquote>') ||
      trimmed.startsWith('__CODE_BLOCK_')
    ) {
      if (inList) {
        processedLines.push(`</${listType}>`);
        inList = false;
        listType = null;
      }
      processedLines.push(trimmed);
      continue;
    }

    // Standard paragraph text
    if (inList) {
      processedLines.push(`</${listType}>`);
      inList = false;
      listType = null;
    }
    processedLines.push(`<p>${trimmed}</p>`);
  }

  if (inList) {
    processedLines.push(`</${listType}>`);
  }

  let finalHtml = processedLines.join('\n');

  // Restore stashed inline code and fenced code blocks
  inlineCodes.forEach((code, idx) => {
    finalHtml = finalHtml.replace(new RegExp(`__INLINE_CODE_${idx}__`, 'g'), code);
  });
  codeBlocks.forEach((code, idx) => {
    finalHtml = finalHtml.replace(new RegExp(`__CODE_BLOCK_${idx}__`, 'g'), code);
  });

  return finalHtml;
}

/**
 * Formats layout placeholders
 */
function applyLayout(template, { title, content, root, activeBlog = '', activeAbout = '' }) {
  return template
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{content\}\}/g, content)
    .replace(/\{\{root\}\}/g, root)
    .replace(/\{\{active_blog\}\}/g, activeBlog)
    .replace(/\{\{active_about\}\}/g, activeAbout);
}

// ----------------------------------------------------
// 1. Build the About Page (about.html)
// ----------------------------------------------------
console.log('Compiling about.html...');
const aboutContent = fs.readFileSync(ABOUT_CONTENT_PATH, 'utf-8');
const compiledAbout = applyLayout(layoutTemplate, {
  title: 'About — UglyDrone',
  content: aboutContent,
  root: './',
  activeAbout: 'active'
});
fs.writeFileSync(ABOUT_OUTPUT_PATH, compiledAbout);
console.log('Successfully compiled about.html');

// ----------------------------------------------------
// 2. Read and Compile All Blog Posts (posts/*.md)
// ----------------------------------------------------
const postsList = [];

if (fs.existsSync(POSTS_DIR)) {
  const files = fs.readdirSync(POSTS_DIR);
  const mdFiles = files.filter(f => f.endsWith('.md'));
  
  console.log(`Found ${mdFiles.length} blog post(s) in posts/...`);
  
  mdFiles.forEach(filename => {
    const filePath = path.join(POSTS_DIR, filename);
    const rawContent = fs.readFileSync(filePath, 'utf-8');
    
    const postBaseName = path.parse(filename).name;
    console.log(`Processing post: ${filename}`);
    const { data, body } = parsePost(rawContent);
    
    // Automatically extract post title from first markdown H1 heading if not in frontmatter
    let postTitle = data.title;
    let cleanBody = body;
    const headingMatch = body.match(/^#\s+(.*?)$/m);
    if (!postTitle && headingMatch) {
      postTitle = headingMatch[1].trim();
      cleanBody = body.replace(/^#\s+.*?$/m, '');
    } else if (!postTitle) {
      postTitle = 'Untitled Post';
    } else if (headingMatch && headingMatch[1].trim() === postTitle) {
      cleanBody = body.replace(/^#\s+.*?$/m, '');
    }

    // Automatically parse date from MMDDYYYY filename format if not in frontmatter
    let postDate = data.date;
    if (!postDate) {
      const dateMatch = postBaseName.match(/(\d{2})(\d{2})(\d{4})/);
      if (dateMatch) {
        postDate = `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}`;
      } else {
        postDate = new Date().toISOString().split('T')[0];
      }
    }
    const postDesc = data.description || '';
    
    // Generate Preview Markdown and compile to HTML
    const previewMd = extractPreview(cleanBody);
    const previewHtml = markdownToHtml(previewMd);
    
    // Compile full post Markdown to HTML
    const fullBodyHtml = markdownToHtml(cleanBody);
    
    // Store metadata for the feed
    postsList.push({
      filename: postBaseName,
      title: postTitle,
      date: postDate,
      description: postDesc,
      previewHtml
    });
    
    // Generate individual post page content wrapped in styles
    const postPageContent = `
      <a href="../index.html" class="back-link">← Back to Blog</a>
      <article class="card post-content" aria-labelledby="post-title">
        <header class="post-header">
          <h1 id="post-title" class="post-title">${postTitle}</h1>
          <div class="post-meta">${postDate}</div>
        </header>
        <div class="textbox">
          ${fullBodyHtml}
        </div>
      </article>
    `;
    
    const compiledPostPage = applyLayout(layoutTemplate, {
      title: `${postTitle} — UglyDrone Blog`,
      content: postPageContent,
      root: '../',
      activeBlog: 'active'
    });
    
    const outputPostPath = path.join(POSTS_DIR, `${postBaseName}.html`);
    fs.writeFileSync(outputPostPath, compiledPostPage);
    console.log(`Generated HTML page: posts/${postBaseName}.html`);
  });
} else {
  console.log('posts/ directory does not exist! Creating it...');
  fs.mkdirSync(POSTS_DIR);
}

// ----------------------------------------------------
// 3. Build the Blog Feed Page (index.html)
// ----------------------------------------------------
console.log('Compiling index.html...');

// Sort posts by date in descending order (newest first)
postsList.sort((a, b) => new Date(b.date) - new Date(a.date));

let feedContent = '';

if (postsList.length === 0) {
  feedContent = `
    <section class="card" aria-label="Empty blog">
      <div class="textbox" style="text-align: center; color: var(--muted); padding: 40px 0;">
        <h2>No blog posts yet!</h2>
        <p>Check back later for updates on the UglyDrone platform.</p>
      </div>
    </section>
  `;
} else {
  feedContent = '<div class="blog-feed">';
  postsList.forEach(post => {
    feedContent += `
      <article class="card post-card" aria-labelledby="title-${post.filename}">
        <header class="post-header">
          <h2 id="title-${post.filename}" class="post-title">
            <a href="posts/${post.filename}.html" class="post-title-link">${post.title}</a>
          </h2>
          <div class="post-meta">${post.date}</div>
        </header>
        <div class="textbox post-preview">
          ${post.previewHtml}
        </div>
        <a href="posts/${post.filename}.html" class="read-more-btn">Read More →</a>
      </article>
    `;
  });
  feedContent += '</div>';
}

const compiledIndex = applyLayout(layoutTemplate, {
  title: 'UglyDrone Blog — Rugged, Modular, Ready',
  content: feedContent,
  root: './',
  activeBlog: 'active'
});

fs.writeFileSync(INDEX_OUTPUT_PATH, compiledIndex);
console.log('Successfully compiled index.html');
console.log('Static site generation complete!');
