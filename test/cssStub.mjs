// Lets the built components load under node: a CSS module import resolves to an empty class map.
import { register } from 'node:module';

const hooks = `
export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  return nextLoad(url, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));
