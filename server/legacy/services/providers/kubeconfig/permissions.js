"use strict";

// Dùng SelfSubjectAccessReview (POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews) —
// hỏi thẳng k8s "token này có quyền X không" mà không cần thử làm rồi xem có lỗi hay không.
// Endpoint này gần như luôn được phép gọi kể cả với token chỉ có quyền xem, nên dùng an toàn để
// dò quyền trước khi thử các thao tác ghi thật (vd tạo jump pod ở dbtunnel-core.js).
async function checkVerb(ctx, { namespace, verb, resource, subresource }) {
  const result = await ctx.authorizationV1.createSelfSubjectAccessReview({
    body: {
      spec: {
        resourceAttributes: {
          namespace,
          verb,
          resource,
          group: "",
          version: "v1",
          ...(subresource ? { subresource } : {})
        }
      }
    }
  });
  return Boolean(result.status?.allowed);
}

module.exports = { checkVerb };
