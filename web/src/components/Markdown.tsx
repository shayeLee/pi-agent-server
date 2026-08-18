import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 助手消息的 Markdown 渲染（GFM：表格、列表、代码块、行内代码）。 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown" data-testid="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
