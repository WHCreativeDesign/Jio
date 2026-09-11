/* Shared morph transitions. Wraps a DOM mutation in the View Transitions API so
   elements that persist across it (named via view-transition-name in CSS) animate
   their position/size instead of jump-cutting — the sidebar's width, the canvas
   panel's slide, one view fading into another. Falls back to a plain mutation
   where the API or reduced-motion isn't available. */
(function (global) {
  'use strict';

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const plain = () => ({ ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve() });

  // Calling startViewTransition() again before the previous one has finished
  // throws "A view transition was already in progress", which Chrome surfaces
  // to the user as a "Transition failed — try reloading the page" banner. Two
  // Tween.run() calls landing in the same tick (two buttons, a fast double
  // click) used to hit this; every call now queues behind whichever transition
  // is still in flight instead of colliding with it.
  let queue = Promise.resolve();

  function run(mutate) {
    if (!document.startViewTransition || reduced()) {
      mutate();
      return plain();
    }
    let resolveStarted, started = new Promise(r => { resolveStarted = r; });
    queue = queue.then(async () => {
      let vt;
      try {
        vt = document.startViewTransition(mutate);
      } catch (e) {
        mutate();
        vt = plain();
      }
      resolveStarted(vt);
      await vt.finished.catch(() => {});
    });
    return {
      ready: started.then(vt => vt.ready),
      finished: started.then(vt => vt.finished),
      updateCallbackDone: started.then(vt => vt.updateCallbackDone),
    };
  }

  global.Tween = { run };
})(window);
