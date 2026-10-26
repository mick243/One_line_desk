import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// 글꼴은 앱 안에 함께 넣어요(바깥 글꼴 서버를 부르지 않아요). 쓰는 글자 묶음만 그때그때 받아요.
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
