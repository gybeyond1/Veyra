import { useEffect, useRef } from 'react';

type Props = {
  onDone: () => void;
};

/**
 * 进入私密模式前的启动动画。
 * 铺满整个窗口（窗口全屏时自然也是全屏），黑底、无控件、点击无响应，声音保留。
 * 播完 / 出错 / 超时都会回调 onDone，避免把人卡在黑屏里。
 */
export default function IntroOverlay({ onDone }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const doneRef = useRef(false);
  const finishRef = useRef(onDone);
  finishRef.current = onDone;

  useEffect(() => {
    const video = videoRef.current;
    let timer = 0;

    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      if (timer) window.clearTimeout(timer);
      finishRef.current();
    };

    timer = window.setTimeout(finish, 9000);
    if (video) {
      video.addEventListener('ended', finish);
      video.addEventListener('error', finish);
      const started = video.play();
      if (started && started.catch) {
        started.catch(() => {
          // 被自动播放策略拦下时先静音起来，起来后立刻恢复声音
          video.muted = true;
          video
            .play()
            .then(() => {
              video.muted = false;
            })
            .catch(finish);
        });
      }
    }

    return () => {
      if (timer) window.clearTimeout(timer);
      video?.removeEventListener('ended', finish);
      video?.removeEventListener('error', finish);
    };
  }, []);

  return (
    <div
      className="intro-layer"
      onClickCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <video ref={videoRef} className="intro-video" src="./intro.mp4" playsInline disablePictureInPicture />
    </div>
  );
}
