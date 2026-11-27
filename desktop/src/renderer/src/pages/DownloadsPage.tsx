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
  error: '有失败集',
  canceled: '已取消',
  paused: '已暂停',
};

const KIND_TEXT: Record<RemoteTask['kind'], string> = {
  nas: '服务器',
  desktop: '电脑',
  android: '手机',
  tv: '电视',
};

/**
 * 「我的 → 下载」。
 *
 * 以前这里是两张长条列表（本机任务 / 其它设备），和「最近在看」「收藏」的封面格子完全两个样子，
 * 明明是同一层的三个 tab，切换过去像进了另一个页面。现在本机任务也用同一套封面卡片，
 * 其余设备的成品留在下面一小段，不抢主视觉。
 */
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
    <>
      {tasks.length === 0 ? (
        <div className="empty-block">
          <h3>还没有下载任务</h3>
          <p>去详情页点「下载」选几集，下完会自动合并成一个文件。</p>
        </div>
      ) : (
        <div className="grid">
          {tasks.map((task) => {
            const failed = task.failedEpisodes?.length || 0;
            const active = task.status === 'downloading' || task.status === 'merging' || task.status === 'queued';
            const finished = task.status === 'done' || Boolean(task.output);
            const percent =
              task.status === 'done' || task.status === 'ready'
                ? 100
                : Math.max(0, Math.min(100, task.percent || 0));
            const subtitle = [
              STATUS_TEXT[task.status] || task.status,
              task.totalCount ? `${task.doneCount}/${task.totalCount} 集` : task.episodeCount ? `全 ${task.episodeCount} 集` : '',
              failed ? `${failed} 集失败` : '',
            ].filter(Boolean).join(' · ');

            return (
              <div key={task.id} className={`tile tile-task${active ? ' active' : ''}`}>
                <div
                  className="tile-art"
                  role="button"
                  tabIndex={0}
                  title={finished ? '播放本地文件' : subtitle}
                  onClick={() => (finished ? onPlay(task) : undefined)}
                  onKeyDown={(event) => {
                    if (finished && (event.key === 'Enter' || event.key === ' ')) onPlay(task);
                  }}
                >
                  <Cover src={task.cover} alt={task.title} />
                  {percent < 100 && (
                    <div className="tile-progress">
                      <i style={{ width: `${Math.max(2, percent)}%` }} />
                    </div>
                  )}
                  <span className="tile-badge">{STATUS_TEXT[task.status] || task.status}</span>
                  {/* 不 hover 也能看出这里还有操作（目录/重试/合并/删除） */}
                  <span className="tile-more" aria-hidden="true">
                    ···
                  </span>
                  {finished && (
                    <span className="tile-play">
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5.5v13l11-6.5z" />
                      </svg>
                    </span>
                  )}
                  {/* 卡片上的操作条：悬停出现，和封面同高，不额外占一行 */}
                  <div className="tile-actions">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void act('已打开目录', () => call('downloads.openFolder', { id: task.id }));
                      }}
                    >
                      目录
                    </button>
                    {failed > 0 && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void act('已重新排队失败集', () => call('downloads.retry', { id: task.id }));
                        }}
                      >
                        重试
                      </button>
                    )}
                    {(task.status === 'ready' || (task.status === 'failed' && failed === 0)) && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void act('已开始合并', () => call('downloads.merge', { id: task.id }));
                        }}
                      >
                        合并
                      </button>
                    )}
                    <button
                      type="button"
                      className="danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!window.confirm(`删除「${task.title}」？已下载的文件会一起删掉。`)) return;
                        void act('已删除任务', () => call('downloads.remove', { id: task.id }));
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
                <p className="tile-title">{task.title}</p>
                <p className="tile-sub">{subtitle}</p>
              </div>
            );
          })}
        </div>
      )}

      {remote.length > 0 && (
        <section className="task-section">
          <header className="task-section-head">
            <h2>其它设备</h2>
            <span>
              {remote.length} 个下载记录
              {playing.length ? ` · ${playing.length} 个可在线播放` : ''}
            </span>
          </header>
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
        </section>
      )}
    </>
  );
}
