// Keep explicit retirement responses for clients using the former website product.
export function retiredApiPath(path: string) {
  return /^\/api\/(credits|sites|curator)(\/|$)/.test(path)
    || /^\/api\/auth\/(switch|detach|link|accounts)$/.test(path)
    || /^\/api\/projects(?:$|\/[^/]+\/(?:claim|claim-email|verify-email|verify|streams)(?:\/|$))/.test(path);
}

export const retiredTools = new Set([
  "list_open_sites", "publish_feedback", "edit_feedback", "delete_feedback",
  "get_site_feedback", "get_new_feedback", "search_feedback", "mark_feedback_useful",
  "mark_feedback_adopted", "comment_on_feedback", "edit_comment", "delete_comment",
  "get_claim_file", "verify_site_claim", "list_streams", "create_stream", "rename_stream", "delete_stream",
]);
