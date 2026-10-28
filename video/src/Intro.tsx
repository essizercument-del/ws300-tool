import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';

// Uygulamanın tema rengi (manifest.json → theme_color)
const BG = '#05120a';
const ACCENT = '#3ddc84';

const Wave: React.FC<{frame: number; width: number}> = ({frame, width}) => {
	const points: string[] = [];
	for (let x = 0; x <= width; x += 8) {
		const t = x / width;
		const y =
			Math.sin(t * 24 + frame * 0.25) * 60 +
			Math.sin(t * 61 + frame * 0.4) * 20;
		points.push(`${x},${y}`);
	}
	return (
		<svg width={width} height={240} viewBox={`0 -120 ${width} 240`}>
			<polyline points={points.join(' ')} fill="none" stroke={ACCENT} strokeWidth={4} />
		</svg>
	);
};

export const Intro: React.FC = () => {
	const frame = useCurrentFrame();
	const {fps, width} = useVideoConfig();
	const scale = spring({frame, fps, config: {damping: 200}});
	const subtitleOpacity = interpolate(frame, [30, 60], [0, 1], {extrapolateRight: 'clamp'});

	return (
		<AbsoluteFill style={{backgroundColor: BG, justifyContent: 'center', alignItems: 'center', fontFamily: 'sans-serif'}}>
			<div style={{position: 'absolute', top: 780, opacity: 0.5}}>
				<Wave frame={frame} width={width} />
			</div>
			<div style={{transform: `scale(${scale})`, color: 'white', fontSize: 160, fontWeight: 800}}>WS300</div>
			<div style={{opacity: subtitleOpacity, color: ACCENT, fontSize: 56, marginTop: 20}}>Titreşim Analiz Aracı</div>
		</AbsoluteFill>
	);
};
