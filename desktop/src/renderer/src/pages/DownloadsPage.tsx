import type { DownloadTask, RemoteTask } from '@shared/types';
import { call, errorText } from '../api';
import Cover from '../components/Cover';

interface Props {
  tasks: DownloadTask[];
  remote: RemoteTask[];
  onRefresh: () => void;
  onPlay: (task: DownloadTask) => void;
  onPlayRemote: (task: RemoteTask) => void;
  notify: (text: string, tone?: 'info' | 'error') => void;
}

const STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  downloading: '下载中',
  running: '下载中',
  merging: '合并中',
  ready: '待合并',
  done: '已完成',
  failed: '有失败集',
  canceled: '已取消',
};

const KIND_TEXT: Record<RemoteTask['kind'], string> = {
  nas: '服务器',
  desktop: '电脑',
  android: '手机',
  tv: '电视',
};

export default function DownloadsPage({ tasks, remote, onRefresh, onPlay, onPlayRemote, notify }: Props) {
  async function act(label: string, job: () => Promise<unknown>) {
    try {
      await job();
      onRefresh();
      notify(label);
    } catch (issue) {
      notify(errorText(issue), 'error');
    }
  }

  const playing = remote.filter((task) => task.playUrl);

  return (
    <div className="page">
      <div className="page-head">
        <h1>下载</h1>
        <p>
          本机 {tasks.length} 个任务
          {remote.length ? ` · 另有 ${remote.length} 个来自手机 / 电视 / 服务器（其中 ${playing.length} 个在线可播）` : ''}
        </p>
      </div>

      <section className="task-section">
        <header className="task-section-head">
          <h2>本机</h2>
          {!tasks.length && <span>还没有下载任务，去详情页点「下载」选几集</span>}
        </header>

        {tasks.length > 0 && (
          <div className="task-list">
            {tasks.map((task) => {
              const failed = task.failedEpisodes?.length || 0;
              const active = task.status === 'downloading' || task.status === 'merging' || task.status === 'queued';
              const percent =
                task.status === 'done' || task.status === 'ready' ? 100 : Math.max(0, Math.min(100, task.percent || 0));
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
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => act('已打开目录', () => call('downloads.openFolder', { id: task.id }))}
                    >
                      目录
                    </button>
                    {failed > 0 && (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => act('已重新排队失败集', () => call('downloads.retry', { id: task.id }))}
                      >
                        重试失败集
                      </button>
                    )}
                    {(task.status === 'ready' || (task.status === 'failed' && failed === 0)) && (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => act('已开始合并', () => call('downloads.merge', { id: task.id }))}
                      >
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
        )}
      </section>

      <section className="task-section">
        <header className="task-section-head">
          <h2>其它设备</h2>
          <span>同一账号下的服务器、手机、电视和另一台电脑；设备在线且有成品时可以直接播</span>
        </header>

        {!remote.length ? (
          <div className="empty-block small">
            <p>没有读到其它设备的下载记录。手机 / 电视 / 电脑需要在线并登录同一账号。</p>
          </div>
        ) : (
          <div className="task-list remote">
            {remote.map((task) => {
              const percent =
                task.status === 'done' || task.status === 'ready'
                  ? 100
                  : Math.max(0, Math.min(100, task.percent || 0));
              return (
                <article key={task.key} className={`task remote ${task.status}`}>
                  <div className="task-cover">
                    <Cover src={task.cover} alt={task.title} />
                  </div>
                  <div className="task-body">
                    <header>
                      <h3 title={task.title}>{task.title}</h3>
                      <span className={`source-badge ${task.kind}`} title={task.deviceName}>
                        {KIND_TEXT[task.kind]}
                        {task.kind !== 'nas' && task.deviceName ? ` · ${task.deviceName}` : ''}
                      </span>
                      <span className={`status ${task.status}`}>{STATUS_TEXT[task.status] || task.status || '—'}</span>
                    </header>
                    <div className="progress">
                      <div className="progress-bar" style={{ width: `${percent}%` }} />
                    </div>
                    <p className="task-detail">
                      {task.totalCount ? `${task.doneCount}/${task.totalCount} 集` : task.episodeCount ? `全 ${task.episodeCount} 集` : ''}
                    </p>
                  </div>
                  <div className="task-actions">
                    {task.playUrl ? (
                      <button type="button" className="primary small" onClick={() => onPlayRemote(task)}>
                        在线播放
                      </button>
                    ) : (
                      <span className="remote-hint">{task.hint || '暂不可播'}</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
