import katex from "katex";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

interface ProtectedSlot {
    id: string;
    html: string;
}

const CODE_INLINE_RE = /`([^`\n]+)`/g;
const DISPLAY_MATH_RE = /\$\$([\s\S]*?)\$\$/g;
// 行内公式：不匹配被反斜杠转义的 $，也不匹配空内容
const INLINE_MATH_RE = /(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;

let slotCounter = 0;
function nextSlotId(): string {
    return `__PET_MATH_SLOT_${slotCounter++}__`;
}

function resetSlotCounter(): void {
    slotCounter = 0;
}

function htmlEscape(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeForRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 保护代码块/行内代码：保留 Markdown 标记，仅把内部内容替换为占位符，
 * 避免其中的 $ 被 KaTeX 误识别。
 */
function protectCodeBlocks(text: string, codeSlots: ProtectedSlot[]): string {
    //  fenced code blocks：保留 ``` 和语言标记
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, content) => {
        const id = nextSlotId();
        codeSlots.push({ id, html: htmlEscape(content) });
        return `\`\`\`${lang}\n${id}\n\`\`\``;
    });

    // 行内代码：保留首尾反引号
    text = text.replace(CODE_INLINE_RE, (match, content) => {
        const id = nextSlotId();
        codeSlots.push({ id, html: htmlEscape(content) });
        return `\`${id}\``;
    });

    return text;
}

/**
 * 渲染块级/行内 LaTeX 公式为 KaTeX HTML，并用占位符替换。
 */
function renderMathToSlots(text: string, mathSlots: ProtectedSlot[]): string {
    const render = (raw: string, latex: string, displayMode: boolean): string => {
        const id = nextSlotId();
        try {
            const html = katex.renderToString(latex.trim(), {
                throwOnError: false,
                displayMode,
            });
            mathSlots.push({ id, html });
        } catch {
            // KaTeX 失败时回退为原始文本
            mathSlots.push({ id, html: htmlEscape(raw) });
        }
        return id;
    };

    return text
        .replace(DISPLAY_MATH_RE, (raw, latex) => render(raw, latex, true))
        .replace(INLINE_MATH_RE, (raw, latex) => render(raw, latex, false));
}

/**
 * 把占位符还原为对应的 HTML。
 */
function restoreSlots(html: string, slots: ProtectedSlot[]): string {
    for (const slot of slots) {
        html = html.replace(
            new RegExp(escapeForRegex(slot.id), "g"),
            () => slot.html,
        );
    }
    return html;
}

/**
 * 渲染 Markdown + LaTeX 公式。
 * 先保护代码块，再提取公式，然后交给 marked 与 DOMPurify，最后插回公式 HTML。
 */
export function renderMarkdownMath(text: string): string {
    resetSlotCounter();

    const codeSlots: ProtectedSlot[] = [];
    const mathSlots: ProtectedSlot[] = [];

    let prepared = protectCodeBlocks(text, codeSlots);
    prepared = renderMathToSlots(prepared, mathSlots);

    const rawHtml = marked.parse(prepared, { async: false }) as string;
    let sanitized = DOMPurify.sanitize(rawHtml, {
        ALLOW_DATA_ATTR: true,
    });

    // 先还原公式（HTML），再还原代码块原始文本
    sanitized = restoreSlots(sanitized, mathSlots);
    sanitized = restoreSlots(sanitized, codeSlots);

    return sanitized;
}

/**
 * 仅渲染 LaTeX（用于 PetBubble 等纯文本简短内容）。
 */
export function renderInlineMath(text: string): string {
    resetSlotCounter();

    const mathSlots: ProtectedSlot[] = [];
    let prepared = renderMathToSlots(text, mathSlots);
    let sanitized = DOMPurify.sanitize(prepared, { ALLOW_DATA_ATTR: true });
    sanitized = restoreSlots(sanitized, mathSlots);
    return sanitized;
}
