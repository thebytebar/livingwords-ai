/**
 * Centralized @tensorflow/tfjs import.
 *
 * Every file that needs TensorFlow.js must import it from here:
 *     import * as tf from './tf.js';
 *
 * This is the ONLY file allowed to directly reference '@tensorflow/tfjs'.
 *
 * Purpose:
 * - Perform the optional early side-effect import of '@tensorflow/tfjs-node' (the native
 *   backend) *before* the main tfjs package runs its initialization.
 * - This prevents the annoying "Hi, looks like you are running TensorFlow.js in Node.js.
 *   To speed things up dramatically, install our node backend..." message.
 * - It also ensures we actually get the faster 'tensorflow' (native) backend instead of
 *   the pure-JS CPU backend for training and inference.
 *
 * The version guard exists because tfjs-node@4.x contains code that calls the long-deprecated
 * (and in Node 23+ completely removed) functions util.isNullOrUndefined and util.isArray.
 * On Node >=23 we simply don't load it and fall back to the JS CPU backend (still works fine
 * for this ~500k parameter model).
 */

// Version guard + early load of the optional native accelerator.
// Must be a top-level await so it happens before we re-export / pull in '@tensorflow/tfjs'.
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 23) {
  await import('@tensorflow/tfjs-node').catch(() => {
    // optional dep not present or failed to initialize its native addon — ignore
  });
}

// Re-export the entire public API of tfjs.
// Using `export * from` means that a consumer writing
//     import * as tf from './tf.js';
// will receive exactly the same namespace object they used to get from the direct import.
// All of `tf.range`, `tf.layers`, `tf.initializers`, `tf.linalg.bandPart`, etc. work unchanged.
export * from '@tensorflow/tfjs';
