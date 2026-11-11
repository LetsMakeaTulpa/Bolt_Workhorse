import { Message } from '../types';
import { User, Compass, Globe, ExternalLink, Search } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MessageBubbleProps {
  message: Message;
  isStreaming: boolean;
}

export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`mb-6 flex gap-3 animate-slide-up ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${
        isUser ? 'bg-bg-elevated border border-border-subtle' : 'bg-gradient-to-br from-accent to-accent-hover'
      }`}>
        {isUser ? <User size={14} className="text-text-secondary" /> : <Compass size={14} className="text-bg-base" />}
      </div>

      <div className={`flex flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'} max-w-[80%]`}>
        {message.search_enabled && message.search_results.length > 0 && (
          <div className="mb-0.5 w-full rounded-lg border border-border-subtle bg-bg-surface p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-olive">
              <Search size={11} />
              <span>Retrieved {message.search_results.length} sources via RRF</span>
            </div>
            <div className="space-y-1">
              {message.search_results.slice(0, 4).map((r, i) => (
                <a
                  key={i}
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-1.5 text-[11px] text-text-secondary hover:text-text-primary transition-colors group"
                >
                  <span className="flex-shrink-0 text-text-muted font-mono">{r.citation_id ?? `[${i+1}]`}</span>
                  <span className="flex-1 truncate group-hover:underline">{r.title}</span>
                  <ExternalLink size={9} className="flex-shrink-0 opacity-0 group-hover:opacity-100 mt-0.5" />
                </a>
              ))}
              {message.search_results.length > 4 && (
                <div className="text-[11px] text-text-muted">+ {message.search_results.length - 4} more sources</div>
              )}
            </div>
          </div>
        )}

        <div className={`rounded-xl px-3.5 py-2.5 ${
          isUser
            ? 'bg-accent text-bg-base'
            : 'bg-bg-surface text-text-primary border border-border-subtle'
        }`}>
          {isStreaming && !message.content ? (
            <div className="flex items-center gap-1 py-1">
              <span className="thinking-dot"></span>
              <span className="thinking-dot"></span>
              <span className="thinking-dot"></span>
            </div>
          ) : isUser ? (
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          )}
        </div>

        {!isUser && message.model && message.content && (
          <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
            {message.search_enabled && <Globe size={9} />}
            <span className="font-mono">{message.model.split('/').pop()}</span>
          </div>
        )}
      </div>
    </div>
  );
}
