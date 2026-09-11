/* Shared morph transitions. Wraps a DOM mutation in the View Transitions API so
   elements that persist across it (named via view-transition-name in CSS) animate
   their position/size instead of jump-cutting — the sidebar's width, the canvas
   panel's slide, one view fading into another. Falls back to a plain mutation
   where the API or reduced-motion isn't available. */
(function (global) {
  'use strict';

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function run(mutate) {
    if (!document.startViewTransition || reduced()) {
      mutate();
      return { ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    }
    try {
      return document.startViewTransition(mutate);
    } catch (e) {
      mutate();
      return { ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    }
  }

  global.Tween = { run };
})(window);
