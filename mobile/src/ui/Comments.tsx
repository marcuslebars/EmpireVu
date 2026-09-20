import { PaperPlaneRight } from "@phosphor-icons/react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useState } from "react";

import { createComment, type CreateCommentInput } from "@m/lib/api";
import { initials, relAgo } from "@m/lib/format";
import { useScope } from "@m/state/scope";
import { Empty, Section } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

interface CommentItem {
  id: string;
  body: string;
  createdAt: string;
  author: { name: string; email: string } | null;
}

export function CommentsSection({
  comments,
  entityType,
  entityId,
  companyId,
  invalidateKey,
}: {
  comments: CommentItem[];
  entityType: CreateCommentInput["entityType"];
  entityId: string;
  companyId: string | null | undefined;
  invalidateKey: QueryKey;
}) {
  const scope = useScope();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");

  const post = useMutation({
    mutationFn: () => createComment(scope.orgId, { body: body.trim(), entityType, entityId, companyId: companyId ?? null }),
    onSuccess: () => {
      setBody("");
      void queryClient.invalidateQueries({ queryKey: invalidateKey });
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't post comment", "error"),
  });

  return (
    <Section title="Comments">
      <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        {comments.length === 0 ? (
          <span className="fine" style={{ fontSize: 12 }}>No comments yet.</span>
        ) : (
          comments.map((comment) => (
            <div key={comment.id} style={{ display: "flex", gap: 10 }}>
              <span style={{ width: 28, height: 28, flex: "none", borderRadius: 9, background: "var(--chip)", display: "flex", alignItems: "center", justifyContent: "center", font: "700 10px/1 Inter, sans-serif", color: "hsl(220 10% 74%)" }}>
                {initials(comment.author?.name || comment.author?.email)}
              </span>
              <span className="grow">
                <span style={{ display: "block", font: "400 12.5px/1.5 Inter, sans-serif", color: "hsl(220 10% 80%)", whiteSpace: "pre-wrap" }}>{comment.body}</span>
                <span style={{ display: "block", font: "400 10px/1 Inter, sans-serif", color: "hsl(220 10% 42%)", marginTop: 5 }}>
                  {[comment.author?.name, relAgo(comment.createdAt)].filter(Boolean).join(" · ")}
                </span>
              </span>
            </div>
          ))
        )}
        <form
          style={{ display: "flex", gap: 8, alignItems: "center" }}
          onSubmit={(event) => {
            event.preventDefault();
            // Guard the in-flight post too — the keyboard's Go key ignores the disabled button.
            if (body.trim() && !post.isPending) post.mutate();
          }}
        >
          <input
            className="input"
            style={{ height: 42, fontSize: 16 }}
            placeholder="Add a comment…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button
            type="submit"
            aria-label="Post comment"
            disabled={!body.trim() || post.isPending}
            style={{ width: 42, height: 42, flex: "none", borderRadius: 11, border: 0, background: "var(--pri)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            {post.isPending ? <span className="spinner" /> : <PaperPlaneRight size={16} weight="fill" />}
          </button>
        </form>
      </div>
    </Section>
  );
}

export { Empty };
