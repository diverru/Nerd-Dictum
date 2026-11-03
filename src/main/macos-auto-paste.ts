import { execFile } from 'node:child_process';

// One native transaction preserves every item/type, including images and file URLs.
export const MAC_AUTO_PASTE_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('Foundation');
function run() {
  var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var text = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding))).text;
  var pb = $.NSPasteboard.generalPasteboard;
  var snapshotVersion = pb.changeCount;
  var saved = $.NSMutableArray.array;
  var items = pb.pasteboardItems;
  for (var i = 0; i < items.count; i++) {
    var item = items.objectAtIndex(i);
    var copy = $.NSPasteboardItem.alloc.init;
    var types = item.types;
    for (var j = 0; j < types.count; j++) {
      var type = types.objectAtIndex(j);
      var data = item.dataForType(type);
      if (data.isNil()) throw new Error('Cannot snapshot clipboard format');
      copy.setDataForType(data, type);
    }
    saved.addObject(copy);
  }
  if (pb.changeCount !== snapshotVersion) return JSON.stringify({ dispatched: false, restored: false, error: 'Clipboard changed during snapshot' });
  pb.clearContents;
  pb.setStringForType($(text), $.NSPasteboardTypeString);
  var version = pb.changeCount;
  try {
    $.NSThread.sleepForTimeInterval(0.05);
    if (pb.changeCount !== version) return JSON.stringify({ dispatched: false, restored: false, error: 'Clipboard changed before paste' });
    Application("System Events").keyCode(9, { using: "command down" });
  } catch (error) {
    return JSON.stringify({ dispatched: false, restored: false, error: String(error) });
  }
  // Dispatch does not acknowledge consumption; give the target a grace period.
  $.NSThread.sleepForTimeInterval(1.5);
  if (pb.changeCount !== version) return JSON.stringify({ dispatched: true, restored: false });
  pb.clearContents;
  if (saved.count > 0 && !pb.writeObjects(saved)) return JSON.stringify({ dispatched: true, restored: false, error: 'Cannot restore clipboard' });
  return JSON.stringify({ dispatched: true, restored: true });
}
`;

export async function pasteWithClipboardRestore(text: string, log: (message: string) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_AUTO_PASTE_SCRIPT],
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Clipboard paste failed: ${stderr || error.message}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          log(`[AutoPaste] dispatched=${result.dispatched} clipboardRestored=${result.restored}${result.error ? ` error=${result.error}` : ''}`);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    child.stdin!.end(JSON.stringify({ text }));
  });
}
