import { memo } from 'react';
import PropTypes from 'prop-types';
import JellyfinPlayer from '../../../components/JellyfinPlayer';

const VideoPlayer = ({ tvId, season = 1, episode = 1 }) => tvId ? <JellyfinPlayer lookupPath={`episode/${tvId}/${season}/${episode}`} title={`Saison ${season}, épisode ${episode}`} unavailableText="Cet épisode n’est pas disponible pour le moment. Réessayez dans quelques minutes." /> : null;
VideoPlayer.propTypes = { tvId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired, season: PropTypes.oneOfType([PropTypes.string, PropTypes.number]), episode: PropTypes.oneOfType([PropTypes.string, PropTypes.number]) };
export default memo(VideoPlayer);
