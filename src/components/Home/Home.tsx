import React from 'react';
import { Divider, Header, Icon } from 'semantic-ui-react';

import { NewRoomButton, JeopardyTopBar } from '../TopBar/TopBar';
import styles from './Home.module.css';

const Feature = ({
  icon,
  text,
  title,
}: {
  icon: string;
  text: string;
  title: string;
}) => {
  return (
    <div
      style={{
        display: 'flex',
        flex: '1 1 0px',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '10px',
        minWidth: '180px',
      }}
    >
      <Icon fitted size="huge" name={icon as any} />
      <h4 className={styles.featureTitle}>{title}</h4>
      <div className={styles.featureText}>{text}</div>
    </div>
  );
};

const Hero = ({
  heroText,
  subText,
  action,
  image,
  color,
}: {
  heroText?: string;
  subText?: string;
  action?: React.ReactNode;
  image?: string;
  color?: string;
}) => {
  return (
    <div className={`${styles.hero} ${color === 'green' ? styles.green : ''}`}>
      <div className={styles.heroInner}>
        <div style={{ padding: '30px', flex: '1 1 0' }}>
          <div className={styles.heroText}>{heroText}</div>
          <div className={styles.subText}>{subText}</div>
          {action}
        </div>
        <div
          style={{
            flex: '1 1 0',
          }}
        >
          <img
            alt="hero"
            style={{ width: '100%', borderRadius: '10px' }}
            src={image}
          />
        </div>
      </div>
    </div>
  );
};

export const JeopardyHome = () => {
  return (
    <div>
      <JeopardyTopBar hideNewRoom />
      <div className={styles.container}>
        <Hero
          heroText={'Play Jeopardy! online with friends.'}
          subText={'Pick from 7,000+ episodes featuring 400,000+ clues.'}
          action={<NewRoomButton />}
          image={'/screenshot3.png'}
        />
        <Divider horizontal>
          <Header inverted as="h4">
            <Icon name="cogs" />
            Features
          </Header>
        </Divider>
        <div className={styles.featureSection}>
          <Feature
            icon="hand point right"
            title="Episode Selector"
            text="Pick any episode by number, or play a random game."
          />
          <Feature
            icon="lightbulb"
            title="Buzzer"
            text="Implements the buzzer logic from the TV show (first correct answer scores points)"
          />
          <Feature
            icon="microphone"
            title="Reading"
            text="Clues are read to you by the computer for a realistic experience."
          />
          <Feature
            icon="gavel"
            title="Judging"
            text="Players perform answer judging themselves, so you're not penalized for incorrect spelling."
          />
          <Feature
            icon="wrench"
            title="Custom Games"
            text="Upload your own data file to play a custom game"
          />
        </div>
      </div>
    </div>
  );
};
