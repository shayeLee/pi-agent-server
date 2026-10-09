import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock.js";

/** 助手消息的 Markdown 渲染（GFM：表格、列表、代码块、行内代码）。 */
export const Markdown = memo(function Markdown({ text, imagePolicy = "allow" }: { text: string; imagePolicy?: "allow" | "link" }) {
  return (
    <div className="markdown" data-testid="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        // Tool output is untrusted: show a sanitized link, never request an image src.
        img: ({ src, alt, title }) => imagePolicy === "link"
          ? <a href={src || undefined} title={title} rel="noopener noreferrer">{alt || "图片"}</a>
          : <img src={src} alt={alt} title={title} />,
        pre: ({ node }) => {
          const code = node?.children.find(child => child.type === "element" && child.tagName === "code");
          if (!code || code.type !== "element") return null;
          const classes = code.properties.className;
          const language = Array.isArray(classes) ? classes.find(c => typeof c === "string" && c.startsWith("language-")) : undefined;
          const value = code.children.map(child => child.type === "text" ? child.value : "").join("");
          return <CodeBlock code={value} language={typeof language === "string" ? language.slice(9) : undefined} />;
        },
      }}>{text}</ReactMarkdown>
    </div>
  );
});
