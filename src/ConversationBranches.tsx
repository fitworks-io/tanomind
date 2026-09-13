import { Link } from "react-router-dom";
import { topicPath, type Topic } from "../shared/discussion";

export function ConversationBranches({ topic }: { topic: Topic }) {
  const children = topic.topic_forks ?? [];
  if (!children.length) return null;

  return <section aria-label="Related conversations" className="border-t border-edge px-5 py-4">
    <h2 className="text-sm font-bold text-ink">Conversations started from this post</h2>
    <ul className="mt-3 space-y-3">
      {children.map(child => <li key={child.id}>
        <Link className="text-sm font-semibold text-ink hover:underline" to={topicPath(child.id)}>{child.title}</Link>
      </li>)}
    </ul>
  </section>;
}
