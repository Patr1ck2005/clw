'use strict';

// A readiness deadline must not cancel the scripts which could make the page
// ready. This adapter only changes the bridge-owned home surface; turn send,
// acknowledgement and execution deadlines remain upstream-owned.
function installSlowNavigationNotice(host,{timeoutMs=180000,setTimer=setTimeout}={}){
  host.clearHomeNavigationTimeout();
  host.armHomeNavigationTimeout=(contents,url)=>{
    host.clearHomeNavigationTimeout();
    host.homeNavigationTimeout=setTimer(()=>{
      host.homeNavigationTimeout=null;
      if(contents.isDestroyed()||!contents.isLoadingMainFrame())return;
      host.logger.warn('browser.navigation_slow');
      host.setState({status:'loading',message:'ChatGPT 页面加载较慢，仍在等待网页；尚未发送消息。',url,loading:true});
    },timeoutMs);
    host.homeNavigationTimeout.unref?.();
  };
  const contents=host.view.webContents;
  if(!contents.isDestroyed()&&contents.isLoadingMainFrame())host.armHomeNavigationTimeout(contents,contents.getURL());
}

module.exports={installSlowNavigationNotice};
