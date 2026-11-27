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
 * 和「最近在看」「收藏」同一套封面卡片：本机任务带进度条、状态角标和 目录/重试/合并/删除；
 * 其它设备（服务器 / 手机 / 电视 / 另一台电脑）的成品也进同一个网格，只保留「来源 + 集数 + 在线播放」，
 * 因为进度和合并发生在它们自己那边，这边能做的只有播。
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

  const empty = tasks.length === 0 && remote.length === 0;

  return (
    <>
      {empty ? (
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
                  title={[finished ? '播放本地文件' : subtitle, failed > 0 ? task.error : ''].filter(Boolean).join('\n')}
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

          {remote.map((task) => {
            const playable = Boolean(task.playUrl);
            const where = KIND_TEXT[task.kind] + (task.kind !== 'nas' && task.deviceName ? ` · ${task.deviceName}` : '');
            // 设备名已经在封面右上角，副标题只留状态和集数，别顶成省略号
            const subtitle = [
              STATUS_TEXT[task.status] || task.status || '',
              task.totalCount ? `${task.doneCount}/${task.totalCount} 集` : task.episodeCount ? `全 ${task.episodeCount} 集` : '',
            ].filter(Boolean).join(' · ');

            return (
              <div key={task.key} className="tile tile-task tile-remote">
                <div
                  className="tile-art"
                  role="button"
                  tabIndex={0}
                  title={playable ? `在线播放（${where}）` : task.hint || `${where} 暂不可播`}
                  onClick={() => (playable ? onPlayRemote(task) : undefined)}
                  onKeyDown={(event) => {
                    if (playable && (event.key === 'Enter' || event.key === ' ')) onPlayRemote(task);
                  }}
                >
                  <Cover src={task.cover} alt={task.title} />
                  {/* 进度和合并都发生在对方设备上，这里不画进度条，只报状态 */}
                  <span className="tile-badge">{STATUS_TEXT[task.status] || task.status || '—'}</span>
                  <span className="tile-more" title={where}>
                    {KIND_TEXT[task.kind]}
                  </span>
                  {playable ? (
                    <span className="tile-play">
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5.5v13l11-6.5z" />
                      </svg>
                    </span>
                  ) : (
                    <span className="tile-offline">{task.hint || '暂不可播'}</span>
                  )}
                </div>
                <p className="tile-title">{task.title}</p>
                <p className="tile-sub">{subtitle}</p>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
