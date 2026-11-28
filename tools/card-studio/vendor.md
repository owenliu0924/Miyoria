# Live2D files (not in git)

`vendor/` holds Live2D's own code, under Live2D's licences, fetched on each machine that renders
cards:

| Path | Source | Licence |
|---|---|---|
| `vendor/live2dcubismcore.min.js` | `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` (Core 5.1.0 on 2026-11-09) | Live2D Proprietary Software License |
| `vendor/framework/` | `git clone --depth 1 --branch 5-r.4 https://github.com/Live2D/CubismWebFramework.git vendor/framework` | Live2D Open Software License |

The framework must match the Core: 5-r.5 calls `csmGetMocVersion(mocBytes)`, which Core 5.1 does
not have. Her model (Cubism 5, moc3 v5) loads with Core 5.1 and framework 5-r.4.

Then `pnpm --filter @miyoria/card-studio build` (without these files it prints why and builds nothing, so CI and
other machines pass), and `pnpm --filter @miyoria/card-studio sample
<out>` renders samples (`SAMPLES_FILE` names a JSON of pose specs).

## Her figure in her room

`build` also makes `dist/figure/figure.js` (`src/figure.ts`, `vite.figure.config.ts`): her Live2D figure for the
room's page, the framework bundled in. `pnpm --filter @miyoria/card-studio build:figure` makes only that one. The
Core serves it, with `vendor/live2dcubismcore.min.js` and her model's files, to the browsers of members the room
is open to (`[modules.api.room] figure`, docs/design/her-room.md §7.3); without the build, Core or model it shows
the recorded loops and says why once in its log. It looks at the build again about once a minute, so a rebuild
needs no restart.

That puts Core and the framework (Live2D's licences above) and her model's moc, textures, physics and idle motion
(the model's own licence) in those browsers.
