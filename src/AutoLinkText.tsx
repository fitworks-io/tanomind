import { autoLinks } from "../shared/autoLinks";

export function AutoLinkText({ text }: { text: string }) {
  return <>{autoLinks(text).map((part, index) => part.href
    ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className="[overflow-wrap:anywhere] underline underline-offset-2 hover:opacity-75">{part.text}</a>
    : part.text)}</>;
}
