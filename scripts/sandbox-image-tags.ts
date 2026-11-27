// The tags the sandbox service looks for, one `role=tag` line each (CI appends them to
// $GITHUB_OUTPUT): the tag is a hash of the image's folder, so an image built under it is the one
// `miyoria sandbox build` would make from the same files.
//
//   pnpm exec tsx --conditions=@miyoria/source scripts/sandbox-image-tags.ts

import {
  imageHash,
  imageSource,
  imageTag,
} from "../packages/workspace/sandbox/src/service/images.ts";

for (const role of ["default", "browser"] as const) {
  const source = imageSource("workers/sandbox/image", role);
  const hash = await imageHash(source.dir, source.skip);
  if (hash === null) throw new Error(`no Dockerfile in ${source.dir}`);
  console.log(`${role}=${imageTag(role, hash)}`);
}
