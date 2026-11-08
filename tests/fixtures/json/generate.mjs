/** Synthetic tail matching the documented D1 Sanford shape; contains no provider data. */
import { writeFile } from 'node:fs/promises';
await writeFile(new URL('./sanford-tail.synthetic.json', import.meta.url), '[\n{"synthetic":true,"id":"one"},\n{"synthetic":true,"id":"two"},\n');
