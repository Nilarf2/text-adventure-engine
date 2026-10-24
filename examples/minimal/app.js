import { compileStory } from '@text-adventure/content';
import { createSession } from '@text-adventure/core';
import { SaveManager } from '@text-adventure/save';
import { LocalStorageSaveStore } from '@text-adventure/web-adapter';

const $ = id => document.getElementById(id);
try {
  const response = await fetch('./story.json');
  if (!response.ok) throw Error('示例剧情无法读取');
  const compiled = compileStory(await response.json());
  let session = createSession(compiled, { seed: 1 });
  const saves = new SaveManager(new LocalStorageSaveStore(undefined, 'minimal-example:'));
  function render() {
    const view = session.getView();
    $('text').textContent = view.line?.text ?? view.prompt ?? view.ending?.text ?? '';
    $('continue').hidden = view.awaiting !== 'continue';
    $('choices').replaceChildren(...(view.choices ?? []).map(choice => {
      const button = document.createElement('button');
      button.textContent = choice.text; button.disabled = choice.disabled;
      button.onclick = () => { session.dispatch({ type: 'choose', optionId: choice.id }); render(); };
      return button;
    }));
  }
  $('continue').onclick = () => { session.dispatch({ type: 'continue' }); render(); };
  $('restart').onclick = () => { session.dispose(); session = createSession(compiled, { seed: 1 }); session.start(); render(); };
  $('save').onclick = async () => { try { await saves.save('manual', session); $('status').textContent = '已保存'; } catch { $('status').textContent = '保存失败，请检查浏览器存储权限'; } };
  $('load').onclick = async () => { try { const loaded = await saves.restore('manual', session, compiled); if (loaded) render(); $('status').textContent = loaded ? '已读取' : '尚无存档'; } catch { $('status').textContent = '存档不可读取'; } };
  session.start(); render();
} catch (error) { $('status').textContent = error.message; }
