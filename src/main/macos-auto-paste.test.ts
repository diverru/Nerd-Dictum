import { describe, expect, it } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { MAC_AUTO_PASTE_SCRIPT } from './macos-auto-paste';

const nativeIt = process.platform === 'darwin' ? it : it.skip;

function runCase(dispatch: string, initial = "pb.setStringForType('old text', $.NSPasteboardTypeString);", delayedRead = false, beforeDispatch = '') {
  const name = `nerd-dictum-test-${crypto.randomUUID()}`;
  const setup = `ObjC.import('AppKit'); var pb = $.NSPasteboard.pasteboardWithName('${name}'); pb.clearContents; ${initial}`;
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', setup]);
  const observedName = name + '-observed';
  if (delayedRead) {
    const reader = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
      ObjC.import('AppKit');
      var source = $.NSPasteboard.pasteboardWithName('${name}');
      for (var i = 0; i < 500 && ObjC.unwrap(source.stringForType($.NSPasteboardTypeString)) !== 'dictated text'; i++) $.NSThread.sleepForTimeInterval(0.01);
      $.NSThread.sleepForTimeInterval(0.5);
      var text = $.NSPasteboard.pasteboardWithName('${name}').stringForType($.NSPasteboardTypeString);
      var observed = $.NSPasteboard.pasteboardWithName('${observedName}');
      observed.clearContents; observed.setStringForType(text, $.NSPasteboardTypeString);
    `], { stdio: 'ignore' });
    reader.unref();
  }
  const script = MAC_AUTO_PASTE_SCRIPT
    .replace('$.NSPasteboard.generalPasteboard', `$.NSPasteboard.pasteboardWithName('${name}')`)
    .replace('Application("System Events").keyCode(9, { using: "command down" });', dispatch)
    .replace('$.NSThread.sleepForTimeInterval(0.05);', beforeDispatch + '$.NSThread.sleepForTimeInterval(0.05);')
    .replace('$.NSThread.sleepForTimeInterval(1.5);', delayedRead ? '$.NSThread.sleepForTimeInterval(1.5);' : '$.NSThread.sleepForTimeInterval(0.05);');
  const result = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
    input: JSON.stringify({ text: 'dictated text' }), encoding: 'utf8',
  }));
  const content = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
    `ObjC.import('AppKit'); var pb = $.NSPasteboard.pasteboardWithName('${name}'); var urls = []; for (var i = 0; i < pb.pasteboardItems.count; i++) urls.push(ObjC.unwrap(pb.pasteboardItems.objectAtIndex(i).stringForType('public.file-url')) || ''); JSON.stringify({text: ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString)) || '', custom: ObjC.unwrap(pb.stringForType('com.nerddictum.test')) || '', urls: urls, consumed: ObjC.unwrap($.NSPasteboard.pasteboardWithName('${observedName}').stringForType($.NSPasteboardTypeString)) || ''});`,
  ], { encoding: 'utf8' });
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); $.NSPasteboard.pasteboardWithName('${name}').releaseGlobally; $.NSPasteboard.pasteboardWithName('${observedName}').releaseGlobally;`]);
  return { result, content: JSON.parse(content) };
}

describe('macOS automatic paste with clipboard restoration', () => {
  nativeIt('keeps the transcript available for a delayed paste and restores all old formats', () => {
    const { result, content } = runCase('',
      "pb.setStringForType('old text', $.NSPasteboardTypeString); pb.setStringForType('custom data', 'com.nerddictum.test');", true);
    expect(result).toMatchObject({ dispatched: true, restored: true });
    expect(content).toMatchObject({ text: 'old text', custom: 'custom data', consumed: 'dictated text' });
  });

  nativeIt('does not overwrite something copied during the paste', () => {
    const { result, content } = runCase("pb.clearContents; pb.setStringForType('new copy', $.NSPasteboardTypeString);");
    expect(result).toMatchObject({ dispatched: true, restored: false });
    expect(content.text).toBe('new copy');
  });

  nativeIt('does not send Paste if the user copies something before dispatch', () => {
    const { result, content } = runCase("throw new Error('must not dispatch');",
      "pb.setStringForType('old text', $.NSPasteboardTypeString);", false,
      "pb.clearContents; pb.setStringForType('new copy', $.NSPasteboardTypeString);");
    expect(result).toMatchObject({ dispatched: false, restored: false, error: 'Clipboard changed before paste' });
    expect(content.text).toBe('new copy');
  });

  nativeIt('detects a new clipboard owner even when the copied text is identical', () => {
    const { result, content } = runCase("pb.clearContents; pb.setStringForType('dictated text', $.NSPasteboardTypeString);");
    expect(result.restored).toBe(false);
    expect(content.text).toBe('dictated text');
  });

  nativeIt('leaves the transcript available for manual paste when dispatch fails', () => {
    const { result, content } = runCase("throw new Error('dispatch failed');");
    expect(result.dispatched).toBe(false);
    expect(content.text).toBe('dictated text');
  });

  nativeIt('restores several copied file items', () => {
    const { result, content } = runCase('', `
      var items = $.NSMutableArray.array;
      for (var i = 0; i < 2; i++) {
        var item = $.NSPasteboardItem.alloc.init;
        item.setStringForType('file:///tmp/file-' + i, 'public.file-url');
        items.addObject(item);
      }
      pb.writeObjects(items);
    `);
    expect(result.restored).toBe(true);
    expect(content.urls).toEqual(['file:///tmp/file-0', 'file:///tmp/file-1']);
  });

  nativeIt('restores an empty clipboard', () => {
    const { result, content } = runCase('', '');
    expect(result.restored).toBe(true);
    expect(content.text).toBe('');
  });
});
