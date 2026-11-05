import type { DownloadTask } from '@shared/types';
import { call, errorText } from '../api';
import Cover from '../components/Cover';

interface Props {
  tasks: DownloadTask[];
  onRefresh: () => void;
  onPlay: (task: DownloadTask) => void;
  notify: (text: string, tone?: 'info' | 'error') => void;
}

const STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  downloading: '下载中',
  merging: '合并中',
  ready: '待合并',
  done: '已完成',
  failed: '有失败集',
  canceled: '已取消',
};

export default function DownloadsPage({ tasks, onRefresh, onPlay, notify }: Props) {
  async function act(label: string, job: () => Promise<unknown>) {
    try {
      await job();
      onRefresh();
      notify(label);
    } catch (issue) {
      notify(errorText(issue), 'error');
    }
  }

  if (!tasks.length) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>下载</h1>
          <p>整剧下载会在本机并发拉取，完成后自动合并成一个 mp4。</p>
        </div>
        <div className="empty-block">
          <h3>还没有下载任务</h3>
          <p>在任意剧集详情页点「下载全剧」，任务会出现在这里。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>下载</h1>
        <p>{tasks.length} 个任务 · 下载完成后自动合并，分集默认保留在任务目录里。</p>
      </div>

      <div className="task-list">
        {tasks.map((task) => {
          const failed = task.failedEpisodes?.length || 0;
          const active = task.status === 'downloading' || task.status === 'merging' || task.status === 'queued';
          const percent = task.status === 'done' || task.status === 'ready' ? 100 : Math.max(0, Math.min(100, task.percent || 0));
          return (
            <article key={task.id} className={`task ${task.status}${active ? ' active' : ''}`}>
              <div className="task-cover">
                <Cover src={task.cover} alt={task.title} />
              </div>
              <div className="task-body">
                <header>
                  <h3 title={task.title}>{task.title}</h3>
                  <span className={`status ${task.status}`}>{STATUS_TEXT[task.status] || task.status}</span>
                </header>
                <div className="progress">
                  <div className="progress-bar" style={{ width: `${percent}%` }} />
                </div>
                <p className="task-detail">
                  {task.detail || ''}
                  {task.totalCount ? ` · ${task.doneCount}/${task.totalCount} 集` : ''}
                  {failed ? ` · ${failed} 集失败` : ''}
                  {task.status === 'done' && task.output ? ` · ${task.output.split(/[\\/]/).pop()}` : ''}
                </p>
                {task.error && <p className="task-error">{task.error}</p>}
              </div>
              <div className="task-actions">
                {(task.status === 'done' || task.output) && (
                  <button type="button" className="primary small" onClick={() => onPlay(task)}>
                    播放本地
                  </button>
                )}
                <button type="button" className="ghost" onClick={() => act('已打开目录', () => call('downloads.openFolder', { id: task.id }))}>
                  目录
                </button>
                {failed > 0 && (
                  <button type="button" className="ghost" onClick={() => act('已重新排队失败集', () => call('downloads.retry', { id: task.id }))}>
                    重试失败集
                  </button>
                )}
                {(task.status === 'ready' || (task.status === 'failed' && failed === 0)) && (
                  <button type="button" className="ghost" onClick={() => act('已开始合并', () => call('downloads.merge', { id: task.id }))}>
                    合并
                  </button>
                )}
                <button
                  type="button"
                  className="ghost danger"
                  onClick={() => {
                    if (!window.confirm(`删除「${task.title}」？已下载的文件会一起删掉。`)) return;
                    void act('已删除任务', () => call('downloads.remove', { id: task.id }));
                  }}
                >
                  删除
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
