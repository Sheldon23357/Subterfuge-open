import {readPromptSections} from '../../../../contracts/src/index.js';

/** Only producer-framed rules may become developer instructions. Preserve every
 * character so saved prompt offsets and the actual model input stay equivalent. */
export function codexInput(prompt:string){
 const sections=readPromptSections(prompt);
 const firstBrief=sections?.findIndex(s=>s.id.startsWith('brief.'))??-1;
 if(!sections||firstBrief<=0||!sections.slice(0,firstBrief).every(s=>s.id.startsWith('instructions.'))||!sections.slice(firstBrief).every(s=>s.id.startsWith('brief.')))
  return {instructions:'',input:prompt};
 const boundary=sections[firstBrief]!.start;
 // Config is passed as an argv element on Windows. Leave unusually large rule
 // blocks intact in stdin rather than exceeding the process command-line limit.
 if(boundary>12000)return {instructions:'',input:prompt};
 return {instructions:prompt.slice(0,boundary),input:prompt.slice(boundary)};
}
