# Join recorded demos

`stitch` joins existing videos in the order you supply. One transition style applies to every join. It does not record a browser or change source takes.

From a source checkout:

```sh
npm run retake -- stitch outputs/first outputs/second outputs/third \
  --out outputs/launch/demo.mp4 --transition fade --transition-ms 400
```

With the installed CLI, use `retake stitch` with the same arguments.

## Inputs and output

Supply at least two video paths or output folders. Each folder supplies its `demo.mp4`.

The first video sets the output size and frame rate. Other videos fit inside that canvas without cropping. Re-render source takes at the desired preset first if you need another output size.

Choose a new MP4 path. The command refuses to overwrite existing files, including source videos. It rejects missing inputs and clips too short for their transition overlaps.

The result is one MP4. Stitch does not create a recording, proof log, thumbnail, or library entry. Keep the source manifests and output folders.

## Transitions

The existing styles are `cut`, `fade`, `dissolve`, `wipeleft`, `wiperight`, `slideleft`, `slideup`, and `circleopen`. The default is `cut`.

Use `--transition-ms` for an overlap from 120 to 1200 milliseconds. The default is 400. `cut` has no overlap.

Each join reduces the combined duration by one overlap. A middle clip needs room for both its incoming and outgoing transitions.

## Audio

Source audio stays aligned with each clip. Non-cut joins crossfade it. Sources without audio contribute silence if other clips have audio.

Add `--no-audio` to make the result silent. Stitch does not synthesize or approve narration. Narration approval still belongs to the person who heard that performance.

For changes inside a take, change its manifest and re-render before stitching. There is no timeline editor or multitrack interface.
