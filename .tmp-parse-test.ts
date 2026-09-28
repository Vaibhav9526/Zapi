import { parseScene, parseAgentActions, extractAgentTask, TAG_STRIP_REGEX, parseTypeTags, parseAllPointTags } from './src/main/services/element-detector';

const sc = [{
  dataBase64: '', displayId: 1, imageWidth: 1600, imageHeight: 900,
  displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }, isCursorScreen: true,
}] as any;

const scene = parseScene(
  'hello [CIRCLE:614,300:46,28:screen0:exponent] [ARROW:660,306:735,340:screen0] [WRITE:740,352:screen0:× 3] [HILITE:560,368:260,34:screen0] [PATH:560,404;650,414;740,404:screen0] [POINT:412,38:click File:screen0] [POINT:430,112:choose Export:screen0] [BOX:10,10:100,50:screen0] [CLEAR] [POINT:5,5:last:screen0] [BADTAG] [POINT:bad]',
  sc,
);
console.log(JSON.stringify(scene));

console.log('STRIP:', JSON.stringify('say [CIRCLE:1,2:3,4:screen0:x] hi [ACT:done:ok] [CLEAR] there [WRITE:1,2:screen0:a\]b] end'.replace(TAG_STRIP_REGEX, '')));

const acts = parseAgentActions(
  'ok [ACT:click:800,450:screen0] [ACT:dclick:10,20:screen0] [ACT:rclick:1,2:screen0] [ACT:move:5,6:screen0] [ACT:drag:100,200:300,400:screen0] [ACT:type:hello \] world] [ACT:key:ctrl+shift+s] [ACT:scroll:down:5] [ACT:scroll:left] [ACT:wait:1200] [ACT:done:all good] [ACT:fail:nope]',
  sc,
);
console.log('ACTS:', JSON.stringify(acts));

for (const t of [
  'agent, open notepad',
  'hey zapi agent take a screenshot',
  'yo clicky agent! fill this in',
  'ZAPI AGENT do the thing',
  'please zapi agent close the window',
  'close the window, zapi agent',
  'agent mode: click the red button',
  'export this image, do it for me',
  'what is my agent doing',
  'hey agent',
]) console.log('TASK', JSON.stringify(t), '→', JSON.stringify(extractAgentTask(t)));

console.log('TYPE still works:', parseTypeTags('[TYPE:a\]b] [TYPE:c]'));
console.log('POINTS still works:', JSON.stringify(parseAllPointTags('[POINT:800,450:hi:screen0]', sc)));
