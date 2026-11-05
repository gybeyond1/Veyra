import type { SeriesCard } from '@shared/types';
import Cover from './Cover';

interface Props {
  item: SeriesCard;
  onOpen: (id: string, fallback: { title: string; cover: string; description?: string; episodeLabel?: string }) => void;
}

export default function SeriesTile({ item, onOpen }: Props) {
  return (
    <button
      type="button"
      className="tile"
      onClick={() =>
        onOpen(item.id, {
          title: item.title,
          cover: item.cover,
          description: item.description,
          episodeLabel: item.episodeCount ? `全 ${item.episodeCount} 集` : '',
        })
      }
      title={item.title}
    >
      <div className="tile-art">
        <Cover src={item.cover} alt={item.title} />
        {item.badge && <span className="tile-badge">{item.badge}</span>}
        <span className="tile-play">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.5v13l11-6.5z" />
          </svg>
        </span>
      </div>
      <p className="tile-title">{item.title}</p>
      {item.tags && item.tags.length > 0 && <p className="tile-sub">{item.tags.slice(0, 2).join(' · ')}</p>}
    </button>
  );
}
