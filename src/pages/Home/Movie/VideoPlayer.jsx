import { memo } from 'react';
import PropTypes from 'prop-types';
import JellyfinPlayer from '../../../components/JellyfinPlayer';

const VideoPlayer = ({ movieId, title }) => movieId ? <JellyfinPlayer lookupPath={`movie/${movieId}`} title={title} unavailableText={`${title || 'Ce film'} n’est pas disponible pour le moment. Réessayez dans quelques minutes.`} /> : null;
VideoPlayer.propTypes = { movieId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired, title: PropTypes.string };
export default memo(VideoPlayer);
